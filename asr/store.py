"""On-disk audio and voiceprints for the Omi speech service.

Audio: each live connection from the Omi app is a session directory with the raw PCM16 it sent
(`audio.pcm`) and `index.jsonl`, which records the wall-clock time of the audio at every point
where the stream resumed after a gap (the pendant stops streaming in silence). That lets a later
request cut out exactly the window of an Omi conversation by its start/end times. Sessions are
deleted after RETENTION_DAYS.

Voiceprints: `voices.json` maps a name ("me" for the owner, otherwise a people/ note title) to a
few normalized speaker embeddings. Biometric data about other people: local only, listable and
deletable (scripts/omi-voice.ts)."""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from engine import SR, cosine

BYTES_PER_SEC = SR * 2
GAP_MS = 1000  # a new index entry when audio arrives this much later than the stream implies
MAX_SAMPLES_PER_VOICE = 12


def now_ms() -> int:
    return int(time.time() * 1000)


class Session:
    def __init__(self, root: Path, start_ms: int | None = None):
        start_ms = start_ms or now_ms()
        self.id = f"{start_ms}-{uuid.uuid4().hex[:6]}"
        self.dir = root / self.id
        self.dir.mkdir(parents=True)
        self.audio = open(self.dir / "audio.pcm", "ab")
        self.index = open(self.dir / "index.jsonl", "a")
        self.bytes = 0
        self.anchor_ms = start_ms  # wall time of the byte at anchor_byte
        self.anchor_byte = 0
        self._mark(start_ms)

    def _mark(self, wall_ms: int):
        self.anchor_ms, self.anchor_byte = wall_ms, self.bytes
        self.index.write(json.dumps({"byte": self.bytes, "wall_ms": wall_ms}) + "\n")
        self.index.flush()

    def append(self, pcm: bytes, recv_ms: int | None = None):
        """[recv_ms] is when this chunk finished arriving; its first byte started len/rate earlier."""
        if len(pcm) % 2:
            pcm = pcm[:-1]
        recv_ms = recv_ms or now_ms()
        chunk_start = recv_ms - len(pcm) * 1000 // BYTES_PER_SEC
        expected = self.anchor_ms + (self.bytes - self.anchor_byte) * 1000 // BYTES_PER_SEC
        if chunk_start - expected > GAP_MS:
            self._mark(chunk_start)
        self.audio.write(pcm)
        self.audio.flush()
        self.bytes += len(pcm)

    def close(self):
        self.audio.close()
        self.index.close()


@dataclass
class Run:
    wall_ms: int  # wall time of this run's first sample
    byte_start: int
    byte_end: int


def session_runs(d: Path) -> list[Run]:
    try:
        size = (d / "audio.pcm").stat().st_size
        marks = [json.loads(l) for l in (d / "index.jsonl").read_text().splitlines() if l.strip()]
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    runs = []
    for i, m in enumerate(marks):
        end = marks[i + 1]["byte"] if i + 1 < len(marks) else size
        if end > m["byte"]:
            runs.append(Run(m["wall_ms"], m["byte"], end))
    return runs


class AudioStore:
    def __init__(self, root: Path, retention_days: float = 7):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.retention_ms = int(retention_days * 86400_000)

    def new_session(self, start_ms: int | None = None) -> Session:
        return Session(self.root, start_ms)

    def extract(self, start_ms: int, end_ms: int) -> tuple[np.ndarray, float]:
        """Audio for [start_ms, end_ms) as float32 with silence where nothing was received, and how
        many seconds of received audio fell in the window."""
        n = max(0, (end_ms - start_ms) * SR // 1000)
        out = np.zeros(n, dtype=np.float32)
        covered = 0
        for d in sorted(self.root.iterdir()):
            if not d.is_dir():
                continue
            for r in session_runs(d):
                r_end_ms = r.wall_ms + (r.byte_end - r.byte_start) * 1000 // BYTES_PER_SEC
                if r_end_ms <= start_ms or r.wall_ms >= end_ms:
                    continue
                lo_ms, hi_ms = max(start_ms, r.wall_ms), min(end_ms, r_end_ms)
                b0 = r.byte_start + ((lo_ms - r.wall_ms) * BYTES_PER_SEC // 1000) // 2 * 2
                count = (hi_ms - lo_ms) * SR // 1000
                with open(d / "audio.pcm", "rb") as f:
                    f.seek(b0)
                    data = np.frombuffer(f.read(count * 2), dtype="<i2").astype(np.float32) / 32768.0
                o = (lo_ms - start_ms) * SR // 1000
                k = min(len(data), n - o)
                if k > 0:
                    out[o:o + k] = data[:k]
                    covered += k
        return out, covered / SR

    def prune(self):
        cutoff = now_ms() - self.retention_ms
        for d in self.root.iterdir():
            try:
                if d.is_dir() and (d / "audio.pcm").stat().st_mtime * 1000 < cutoff:
                    shutil.rmtree(d)
            except FileNotFoundError:
                pass


class Voices:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, dict]:
        try:
            return json.loads(self.path.read_text()).get("voices", {})
        except FileNotFoundError:
            return {}

    def _save(self, voices: dict):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": 1, "voices": voices}))
        os.replace(tmp, self.path)

    def add(self, name: str, emb: np.ndarray, source: str, replace: bool = False) -> int:
        voices = self.load()
        v = voices.get(name) if not replace else None
        v = v or {"embeddings": [], "sources": []}
        v["embeddings"] = (v["embeddings"] + [emb.round(5).tolist()])[-MAX_SAMPLES_PER_VOICE:]
        v["sources"] = (v["sources"] + [source])[-MAX_SAMPLES_PER_VOICE:]
        v["updated_ms"] = now_ms()
        voices[name] = v
        self._save(voices)
        return len(v["embeddings"])

    def delete(self, name: str) -> bool:
        voices = self.load()
        if name not in voices:
            return False
        del voices[name]
        self._save(voices)
        return True

    def centroids(self) -> dict[str, np.ndarray]:
        out = {}
        for name, v in self.load().items():
            if v.get("embeddings"):
                c = np.mean(np.array(v["embeddings"], dtype=np.float32), axis=0)
                out[name] = c / (np.linalg.norm(c) + 1e-9)
        return out

    def best_match(self, emb: np.ndarray, exclude: set[str], min_score: float, margin: float) -> tuple[str, float] | None:
        """The registered voice closest to [emb], only if it clears [min_score] and beats the
        runner-up by [margin] (similar voices must not be confused)."""
        scored = sorted(((cosine(emb, c), n) for n, c in self.centroids().items() if n not in exclude), reverse=True)
        if not scored or scored[0][0] < min_score:
            return None
        if len(scored) > 1 and scored[0][0] - scored[1][0] < margin:
            return None
        return scored[0][1], scored[0][0]
