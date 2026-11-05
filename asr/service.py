"""Omi speech service (localhost only; locket proxies the public WebSocket and checks the
secret). Three jobs:

1. GET /stt (WebSocket): the Omi app's Custom live transcription. Receives raw PCM16 mono 16 kHz,
   stores it (store.AudioStore), cuts utterances with Silero VAD, transcribes them with Parakeet,
   and answers {"segments": [{text, speaker, start, end, is_user}]}. is_user comes from the
   owner's voiceprint, so Omi's own processing still knows which lines are the owner's.
2. POST /process {start_ms, end_ms}: after Omi closes a conversation, diarize and re-transcribe
   that window from stored audio, label the owner, and hint at known voices.
3. /voices: enroll the owner, learn confirmed people, list and delete voiceprints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from aiohttp import WSMsgType, web

from engine import SR, Models, Turn, cosine, pcm16_to_float
from store import AudioStore, Voices, now_ms

STATE = Path(os.environ.get("STATE_DIR", Path(__file__).parent.parent / "state")).resolve() / "omi"
PORT = int(os.environ.get("OMI_ASR_PORT", "8791"))
RETENTION_DAYS = float(os.environ.get("OMI_AUDIO_RETENTION_DAYS", "7"))
# Voice thresholds: cosine similarity of WeSpeaker embeddings. The owner ones come from one real
# enrollment on the pendant (the owner's own 4-9 s utterances scored 0.80-0.82 against the
# voiceprint); different real voices usually score well below 0.6. Tune per user if needed.
OWNER_TURN = float(os.environ.get("OMI_OWNER_TURN", "0.72"))  # an utterance is the owner's
OWNER_LIVE = float(os.environ.get("OMI_OWNER_LIVE", "0.70"))
PERSON_MATCH = float(os.environ.get("OMI_PERSON_MATCH", "0.70"))
MARGIN = float(os.environ.get("OMI_VOICE_MARGIN", "0.05"))
SAME_SPEAKER = float(os.environ.get("OMI_SAME_SPEAKER", "0.70"))  # one voice across utterances
LIVE_SAME_SPEAKER = float(os.environ.get("OMI_LIVE_SAME_SPEAKER", "0.70"))
# Learning refuses a voice this close to the owner's, so the owner can't become someone else.
LEARN_OWNER_GUARD = float(os.environ.get("OMI_LEARN_OWNER_GUARD", "0.60"))
LIVE_QUEUE_MAX = 200  # utterances awaiting transcription per live connection
MAX_WINDOW_MS = 4 * 3600_000

log = logging.getLogger("omi-asr")


def letters(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


class App:
    def __init__(self, models: Models, state: Path = STATE):
        self.m = models
        self.store = AudioStore(state / "audio", RETENTION_DAYS)
        self.voices = Voices(state / "voices.json")
        self.runs = state / "asr-runs"
        self.runs.mkdir(parents=True, exist_ok=True)

    # --- 1. live ---

    async def stt(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        session = self.store.new_session()
        vad = self.m.new_vad()
        centroids: list[np.ndarray] = []
        pending = np.zeros(0, dtype=np.float32)
        queue: asyncio.Queue = asyncio.Queue(maxsize=LIVE_QUEUE_MAX + 1)
        dropped = 0
        # Protocol diagnostics for the close log: what arrived, what we answered, who ended it.
        stats = {"binary_frames": 0, "text_frames": {}, "segments_sent": 0, "send_errors": 0, "ended_by": "client_closed"}
        log.info(json.dumps({"msg": "stt connected", "session": session.id,
                             "owner_enrolled": self.voices.centroids().get("me") is not None}))

        async def send_results():
            while True:
                item = await queue.get()
                if item is None:
                    return
                try:
                    await send_one(*item)
                except Exception as e:  # one bad utterance must not end live transcription
                    stats["send_errors"] += 1
                    log.warning(json.dumps({"msg": "stt utterance failed", "session": session.id, "error": str(e)[:200]}))

        async def send_one(start: float, samples: np.ndarray):
            text = await asyncio.to_thread(self.m.transcribe, samples)
            if not text:
                return
            emb = await asyncio.to_thread(self.m.embed, samples)
            owner = self.voices.centroids().get("me")  # cached; a new enrollment applies at once
            is_user, speaker = False, "SPEAKER_01"
            if emb is not None and owner is not None and cosine(emb, owner) >= OWNER_LIVE:
                is_user, speaker = True, "SPEAKER_00"
            elif emb is not None:
                scores = [cosine(emb, c) for c in centroids]
                k = int(np.argmax(scores)) if scores else -1
                if k < 0 or scores[k] < LIVE_SAME_SPEAKER:
                    centroids.append(emb)
                    k = len(centroids) - 1
                speaker = f"SPEAKER_{k + 1:02d}"
            seg = {"text": text, "speaker": speaker, "start": round(start, 2),
                   "end": round(start + len(samples) / SR, 2), "is_user": is_user}
            if not ws.closed:
                await ws.send_str(json.dumps({"segments": [seg]}))
                stats["segments_sent"] += 1

        sender = asyncio.create_task(send_results())

        def drain():
            nonlocal dropped
            while not vad.empty():
                seg = vad.front
                if queue.qsize() < LIVE_QUEUE_MAX:
                    queue.put_nowait((seg.start / SR, np.array(seg.samples, dtype=np.float32)))
                else:  # transcription is far behind; the audio is still stored for the later pass
                    dropped += 1
                vad.pop()

        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    stats["binary_frames"] += 1
                    session.append(msg.data)
                    pending = np.concatenate([pending, pcm16_to_float(msg.data)])
                    n = len(pending) // 512 * 512
                    for i in range(0, n, 512):  # Silero takes exactly one 512-sample window per call
                        vad.accept_waveform(pending[i:i + 512])
                    if n:
                        pending = pending[n:]
                        drain()
                elif msg.type == WSMsgType.TEXT:
                    try:
                        kind = str(json.loads(msg.data).get("type", "untyped"))[:40]
                    except (json.JSONDecodeError, AttributeError):
                        kind = "not_json"
                    stats["text_frames"][kind] = stats["text_frames"].get(kind, 0) + 1
                    if kind == "CloseStream":
                        stats["ended_by"] = "client_closestream"
                        break
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    stats["ended_by"] = "client_error" if msg.type == WSMsgType.ERROR else "client_closed"
                    break
        except Exception as e:
            stats["ended_by"] = f"server_error: {type(e).__name__}"
            raise
        finally:
            vad.flush()
            drain()
            queue.put_nowait(None)
            try:
                await asyncio.wait_for(sender, timeout=60)
            except (asyncio.TimeoutError, Exception):
                sender.cancel()
            session.close()
            log.info(json.dumps({"msg": "stt closed", "session": session.id, "seconds": round(session.bytes / (SR * 2), 1),
                                 "dropped_live": dropped, "close_code": ws.close_code, **stats}))
            if not ws.closed:
                await ws.close()
        return ws

    # --- 2. after the conversation ---

    def _utterances(self, audio: np.ndarray) -> list[Turn]:
        """Utterances cut at pauses (Silero VAD), each tagged with the pyannote speaker that
        overlaps it most. Diarized turns can span two people who answer each other quickly; a
        pause-delimited utterance almost never does, so it is the unit voices are judged on."""
        diar = self.m.diarize(audio)
        vad = self.m.new_vad()
        segs = []

        def drain():
            while not vad.empty():
                segs.append((vad.front.start, len(vad.front.samples)))
                vad.pop()

        for i in range(0, len(audio) // 512 * 512, 512):  # Silero takes exactly one 512-sample window per call
            vad.accept_waveform(audio[i:i + 512])
            if i % (512 * 64) == 0:
                drain()
        drain()
        vad.flush()
        drain()
        out = []
        for first, count in segs:
            start, end = first / SR, (first + count) / SR
            ov: dict[int, float] = {}
            for s, e, k in diar:
                o = min(e, end) - max(s, start)
                if o > 0:
                    ov[k] = ov.get(k, 0) + o
            out.append(Turn(start, end, max(ov, key=ov.get) if ov else -1))
        return out

    def _assign_speakers(self, audio: np.ndarray, turns: list, owner: np.ndarray | None) -> tuple[list[str], str | None]:
        """Speaker key per turn ("owner" or "c<n>") and how the owner was found.

        Voices are grouped from per-utterance voiceprints, not pyannote's clusters: on real pendant
        audio pyannote split one person talking alone into three clusters (their voiceprints
        scored 0.71-0.90 against each other). With an enrolled owner, each utterance is first
        compared to the owner directly. pyannote only places utterances too short to fingerprint.
        Without enrollment, the only voice, or the clearly loudest one, is taken as the owner."""
        embs = [self.m.embed(audio[int(t.start * SR):int(t.end * SR)]) if t.end - t.start >= 1.0 else None for t in turns]
        keys: list[str | None] = [None] * len(turns)
        cents: list[np.ndarray] = []
        members: list[list[np.ndarray]] = []
        order = sorted(range(len(turns)), key=lambda i: turns[i].end - turns[i].start, reverse=True)
        for i in order:
            e = embs[i]
            if e is None:
                continue
            if owner is not None and cosine(e, owner) >= OWNER_TURN:
                keys[i] = "owner"
                continue
            scores = [cosine(e, c) for c in cents]
            k = int(np.argmax(scores)) if scores else -1
            if k < 0 or scores[k] < SAME_SPEAKER:
                cents.append(e)
                members.append([e])
                k = len(cents) - 1
            else:
                members[k].append(e)
                c = np.mean(members[k], axis=0)
                cents[k] = c / (np.linalg.norm(c) + 1e-9)
            keys[i] = f"c{k}"
        # Merge groups whose centroids ended up close (order effects in greedy grouping).
        alias = list(range(len(cents)))
        for x in range(len(cents)):
            for y in range(x):
                if alias[y] == y and cosine(cents[x], cents[y]) >= SAME_SPEAKER:
                    alias[x] = y
                    break
        keys = [f"c{alias[int(k[1:])]}" if k and k.startswith("c") else k for k in keys]
        # Short utterances: the most common key among fingerprinted ones in the same pyannote cluster.
        by_diar: dict[int, dict[str, int]] = {}
        for i, t in enumerate(turns):
            if keys[i]:
                by_diar.setdefault(t.speaker, {}).setdefault(keys[i], 0)
                by_diar[t.speaker][keys[i]] += 1
        for i, t in enumerate(turns):
            if keys[i] is None:
                votes = by_diar.get(t.speaker)
                keys[i] = max(votes, key=votes.get) if votes else f"d{t.speaker}"
        if owner is not None:
            return keys, "voiceprint" if "owner" in keys else None
        rms: dict[str, list[float]] = {}
        for i, t in enumerate(turns):
            x = audio[int(t.start * SR):int(t.end * SR)]
            if len(x):
                rms.setdefault(keys[i], []).append(float(np.sqrt(np.mean(x ** 2))))
        loud = sorted(((float(np.mean(v)), k) for k, v in rms.items()), reverse=True)
        if loud and (len(loud) == 1 or loud[0][0] >= 1.5 * loud[1][0]):
            top = loud[0][1]
            return ["owner" if k == top else k for k in keys], "loudest voice (owner not enrolled)"
        return keys, None

    def _process(self, start_ms: int, end_ms: int) -> dict:
        audio, covered = self.store.extract(start_ms, end_ms)
        result = {"covered_seconds": round(covered, 1), "segments": [], "speakers": [], "owner_enrolled": False}
        if covered < 2:
            return result
        turns = self._utterances(audio)
        for t in turns:
            t.text = self.m.transcribe(audio[int(t.start * SR):int(t.end * SR)])
        turns = [t for t in turns if t.text]
        owner = self.voices.centroids().get("me")
        result["owner_enrolled"] = owner is not None
        keys, owner_source = self._assign_speakers(audio, turns, owner)
        order = []
        for k in keys:
            if k not in order:
                order.append(k)
        labels, n = {}, 0
        for k in order:
            if k == "owner":
                labels[k] = "Me"
            else:
                labels[k] = f"Speaker {letters(n)}"
                n += 1
        run_id = f"{start_ms}-{uuid.uuid4().hex[:6]}"
        clusters = {}
        for idx, k in enumerate(order):
            mine = sorted((t for t, kk in zip(turns, keys) if kk == k), key=lambda t: t.end - t.start, reverse=True)
            clip, total = [], 0.0
            for t in mine:
                if total >= 30:
                    break
                clip.append(audio[int(t.start * SR):int(t.end * SR)])
                total += t.end - t.start
            emb = self.m.embed(np.concatenate(clip)) if clip else None
            seconds = round(sum(t.end - t.start for t in mine), 1)
            match, owner_score = None, None
            if emb is not None and owner is not None:
                owner_score = round(cosine(emb, owner), 3)
            if k != "owner" and emb is not None:
                m = self.voices.best_match(emb, {"me"}, PERSON_MATCH, MARGIN)
                if m:
                    match = {"name": m[0], "score": round(m[1], 3)}
            clusters[str(idx)] = {"label": labels[k], "seconds": seconds, "is_user": k == "owner",
                                  "owner_score": owner_score, "emb": emb.round(5).tolist() if emb is not None else None}
            result["speakers"].append({
                "label": labels[k], "cluster": idx, "seconds": seconds, "is_user": k == "owner",
                "owner_source": owner_source if k == "owner" else None, "owner_score": owner_score,
                "voice_match": match,
            })
        idx_of = {k: i for i, k in enumerate(order)}
        for t, k in zip(turns, keys):
            last = result["segments"][-1] if result["segments"] else None
            if last and last["cluster"] == idx_of[k] and start_ms + int(t.start * 1000) - last["end_ms"] <= 1500:
                last["text"] += " " + t.text
                last["end_ms"] = start_ms + int(t.end * 1000)
                continue
            result["segments"].append({
                "text": t.text, "speaker": labels[k], "is_user": k == "owner",
                "start_ms": start_ms + int(t.start * 1000), "end_ms": start_ms + int(t.end * 1000),
                "cluster": idx_of[k],
            })
        # Cluster voiceprints stay here (7 days) so a confirmed identity can be learned later.
        (self.runs / f"{run_id}.json").write_text(json.dumps({"start_ms": start_ms, "end_ms": end_ms, "clusters": clusters}))
        result["run_id"] = run_id
        return result

    async def process(self, request: web.Request) -> web.Response:
        body = await request.json()
        start_ms, end_ms = int(body["start_ms"]), int(body["end_ms"])
        if end_ms <= start_ms or end_ms - start_ms > MAX_WINDOW_MS:
            return web.json_response({"error": "bad window"}, status=400)
        t = time.time()
        result = await asyncio.to_thread(self._process, start_ms, end_ms)
        log.info(json.dumps({"msg": "processed", "window_s": (end_ms - start_ms) // 1000, "covered_s": result["covered_seconds"],
                             "speakers": len(result["speakers"]), "took_s": round(time.time() - t, 1)}))
        return web.json_response(result)

    # --- 3. voiceprints ---

    def _dominant(self, audio: np.ndarray) -> tuple[np.ndarray | None, float, float, int]:
        """Embedding of the voice with most speech, its seconds, everyone else's, and voice count,
        grouped per utterance the same way conversations are."""
        turns = self._utterances(audio)
        keys, _ = self._assign_speakers(audio, turns, None)
        per: dict[str, float] = {}
        for t, k in zip(turns, keys):
            per[k] = per.get(k, 0) + t.end - t.start
        if not per:
            return None, 0, 0, 0
        top = max(per, key=per.get)
        x = np.concatenate([audio[int(t.start * SR):int(t.end * SR)] for t, k in zip(turns, keys) if k == top])
        return self.m.embed(x[: 60 * SR]), per[top], sum(per.values()) - per[top], len(per)

    async def enroll(self, request: web.Request) -> web.Response:
        """{name, start_ms, end_ms} or {name, wav}: the dominant voice becomes [name]'s voiceprint."""
        body = await request.json()
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        if body.get("wav"):
            audio, sr = await asyncio.to_thread(sf.read, body["wav"], dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
            if sr != SR:
                return web.json_response({"error": f"wav must be {SR} Hz mono"}, status=400)
            source = f"wav {Path(body['wav']).name}"
        else:
            audio, _ = await asyncio.to_thread(self.store.extract, int(body["start_ms"]), int(body["end_ms"]))
            source = f"window {body['start_ms']}"
        emb, seconds, others, count = await asyncio.to_thread(self._dominant, audio)
        if emb is None or seconds < 15:
            return web.json_response({"error": f"need at least 15 s of one voice, found {seconds:.0f} s"}, status=422)
        n = self.voices.add(name, emb, source, replace=bool(body.get("replace")))
        return web.json_response({"name": name, "seconds": round(seconds, 1), "other_seconds": round(others, 1),
                                  "speakers_found": count, "samples": n})

    def learn_cluster(self, name: str, run_id: str, cluster: str) -> tuple[int, dict]:
        """A confirmed speaker from a processed window joins [name]'s voiceprint, unless it sounds
        like the owner or already matches someone else."""
        if not name or name == "me" or "/" in run_id or not run_id:
            return 400, {"error": "bad request"}
        try:
            run = json.loads((self.runs / f"{run_id}.json").read_text())
        except FileNotFoundError:
            return 404, {"error": "run expired"}
        c = run["clusters"].get(cluster)
        if not c or not c.get("emb") or c["seconds"] < 10:
            return 422, {"error": "not enough speech from that speaker"}
        emb = np.array(c["emb"], dtype=np.float32)
        # Never let the owner's voice (or a mix containing it) become someone else's voiceprint.
        owner = self.voices.centroids().get("me")
        if c.get("is_user") or (owner is not None and cosine(emb, owner) >= LEARN_OWNER_GUARD):
            return 409, {"error": "that speaker sounds like the owner; not learned"}
        other = self.voices.best_match(emb, {"me", name}, PERSON_MATCH, 0)
        if other:
            return 409, {"error": f"that voice already matches {other[0]}; not learned"}
        return 200, {"name": name, "samples": self.voices.add(name, emb, f"run {run_id}")}

    async def learn(self, request: web.Request) -> web.Response:
        body = await request.json()
        status, out = self.learn_cluster(str(body.get("name", "")).strip(), str(body.get("run_id", "")), str(body.get("cluster")))
        return web.json_response(out, status=status)

    async def stats(self, request: web.Request) -> web.Response:
        """{last_audio_ms, seconds_since}: last live audio received, and seconds received between
        ?since_ms and ?until_ms (default now)."""
        since = int(request.query.get("since_ms", "0") or 0)
        until = int(request.query["until_ms"]) if request.query.get("until_ms") else None
        last, total = await asyncio.to_thread(self.store.received, since, until)
        return web.json_response({"last_audio_ms": last, "seconds_since": round(total, 1)})

    async def list_voices(self, _: web.Request) -> web.Response:
        return web.json_response({n: {"samples": len(v["embeddings"]), "updated_ms": v.get("updated_ms"),
                                      "sources": v.get("sources", [])} for n, v in self.voices.load().items()})

    async def delete_voice(self, request: web.Request) -> web.Response:
        return web.json_response({"deleted": self.voices.delete(request.match_info["name"])})

    async def prune_loop(self):
        while True:
            try:
                self.store.prune()
                cutoff = time.time() - RETENTION_DAYS * 86400
                for f in self.runs.glob("*.json"):
                    if f.stat().st_mtime < cutoff:
                        f.unlink()
            except Exception as e:  # never let cleanup kill the service
                log.warning(json.dumps({"msg": "prune failed", "error": str(e)}))
            await asyncio.sleep(3600)


def make_app(models: Models) -> web.Application:
    a = App(models)
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.add_routes([
        web.get("/healthz", lambda _: web.Response(text="ok")),
        web.get("/stats", a.stats),
        web.get("/stt", a.stt),
        web.post("/process", a.process),
        web.post("/voices/enroll", a.enroll),
        web.post("/voices/learn", a.learn),
        web.get("/voices", a.list_voices),
        web.delete("/voices/{name}", a.delete_voice),
    ])

    async def start_prune(app):
        app["prune"] = asyncio.create_task(a.prune_loop())

    app.on_startup.append(start_prune)
    return app


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    web.run_app(make_app(Models()), host="127.0.0.1", port=PORT, print=None)
