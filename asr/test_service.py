"""Speaker assignment and the learning guard, with a fake model: each test utterance is a constant
signal whose level encodes the speaker, and the fake embedding maps that speaker to a fixed
voiceprint. Run: cd asr && .venv/bin/python -m pytest -q"""

import json

import numpy as np

from engine import SR, Turn
from service import App

DIM = 8


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


# Voiceprints: the owner, two other people, and one voice close to the owner's (a sibling, say).
VOICES = {
    1: unit([1, 0, 0, 0, 0, 0, 0, 0]),  # owner
    2: unit([0, 1, 0, 0, 0, 0, 0, 0]),
    3: unit([0, 0, 1, 0, 0, 0, 0, 0]),
    4: unit([0.8, 0.6, 0, 0, 0, 0, 0, 0]),  # 0.8 similar to the owner
}


class FakeModels:
    def embed(self, samples):
        if len(samples) < SR * 0.8:
            return None
        speaker = int(round(float(np.mean(samples)) * 100))
        return VOICES[speaker]


def build(segments):
    """[(speaker, seconds, pyannote_cluster)] -> audio and turns, 0.5 s of silence between."""
    audio, turns, t = [], [], 0.0
    for speaker, seconds, diar in segments:
        n = int(seconds * SR)
        audio.append(np.full(n, speaker / 100, dtype=np.float32))
        turns.append(Turn(t, t + seconds, diar))
        t += seconds
        audio.append(np.zeros(SR // 2, dtype=np.float32))
        t += 0.5
    return np.concatenate(audio), turns


def test_owner_found_by_voiceprint_and_others_grouped(tmp_path):
    app = App(FakeModels(), tmp_path)
    audio, turns = build([(1, 3, 0), (2, 4, 0), (1, 2, 1), (3, 3, 1), (2, 2, 2)])
    keys, source = app._assign_speakers(audio, turns, VOICES[1])
    assert source == "voiceprint"
    assert keys[0] == keys[2] == "owner"
    assert keys[1] == keys[4] != keys[3]  # speaker 2 is one group even across pyannote clusters
    assert "owner" not in (keys[1], keys[3])


def test_one_voice_split_by_pyannote_stays_one_speaker(tmp_path):
    # The first real pendant recording: one person alone, split by pyannote into three clusters.
    app = App(FakeModels(), tmp_path)
    audio, turns = build([(1, 4, 0), (1, 5, 1), (1, 3, 2)])
    keys, source = app._assign_speakers(audio, turns, None)
    assert keys == ["owner", "owner", "owner"]
    assert source == "loudest voice (owner not enrolled)"


def test_short_utterances_follow_their_pyannote_cluster(tmp_path):
    app = App(FakeModels(), tmp_path)
    audio, turns = build([(1, 3, 0), (2, 3, 1), (2, 0.5, 1), (1, 0.5, 0)])
    keys, _ = app._assign_speakers(audio, turns, VOICES[1])
    assert keys[2] == keys[1] and keys[3] == "owner"


def write_run(app, clusters):
    run = {"start_ms": 0, "end_ms": 1, "clusters": {
        str(i): {"label": label, "seconds": seconds, "is_user": is_user, "emb": VOICES[v].tolist()}
        for i, (label, v, seconds, is_user) in enumerate(clusters)}}
    (app.runs / "run-1.json").write_text(json.dumps(run))


def test_learning_never_takes_the_owners_voice(tmp_path):
    app = App(FakeModels(), tmp_path)
    app.voices.add("me", VOICES[1], "test")
    write_run(app, [("Me", 1, 30, True), ("Speaker A", 2, 30, False), ("Speaker B", 4, 30, False), ("Speaker C", 3, 5, False)])
    assert app.learn_cluster("Dana Okafor", "run-1", "0")[0] == 409  # labeled as the owner
    assert app.learn_cluster("Dana Okafor", "run-1", "2")[0] == 409  # sounds like the owner (0.8)
    assert app.learn_cluster("Dana Okafor", "run-1", "3")[0] == 422  # too little speech
    status, out = app.learn_cluster("Dana Okafor", "run-1", "1")
    assert status == 200 and out["samples"] == 1
    # The same voice can't then be taught as someone else.
    assert app.learn_cluster("Mira Castillo", "run-1", "1")[0] == 409
    assert app.learn_cluster("me", "run-1", "1")[0] == 400
    assert app.learn_cluster("Dana Okafor", "../etc", "1")[0] == 400
    assert app.learn_cluster("Dana Okafor", "missing", "1")[0] == 404


def test_voiceprint_cache_sees_new_enrollment(tmp_path):
    app = App(FakeModels(), tmp_path)
    assert app.voices.centroids() == {}
    app.voices.add("me", VOICES[1], "test")
    assert "me" in app.voices.centroids()
    app.voices.delete("me")
    assert "me" not in app.voices.centroids()
