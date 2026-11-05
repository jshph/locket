"""Run: cd asr && .venv/bin/python -m pytest -q"""

import json

import numpy as np

from engine import SR
from store import AudioStore, Voices
from service import letters


def pcm(seconds: float, value: int) -> bytes:
    return (np.full(int(seconds * SR), value, dtype="<i2")).tobytes()


def test_extract_places_audio_by_wall_clock_across_gaps(tmp_path):
    store = AudioStore(tmp_path)
    t0 = 1_800_000_000_000
    s = store.new_session(start_ms=t0)
    s.append(pcm(2, 1000), recv_ms=t0 + 2000)  # 0-2 s
    s.append(pcm(1, 2000), recv_ms=t0 + 8000)  # pendant slept; resumes at 7 s
    s.close()
    marks = [json.loads(l) for l in (s.dir / "index.jsonl").read_text().splitlines()]
    assert [m["wall_ms"] for m in marks] == [t0, t0 + 7000]
    audio, covered = store.extract(t0 - 1000, t0 + 9000)
    assert len(audio) == 10 * SR and covered == 3
    v = (audio * 32768).round().astype(int)
    assert (v[0:SR] == 0).all()  # before the session
    assert (v[SR:3 * SR] == 1000).all()
    assert (v[3 * SR:8 * SR] == 0).all()  # the gap stays silent
    assert (v[8 * SR:9 * SR] == 2000).all()
    part, covered = store.extract(t0 + 1500, t0 + 7500)
    assert covered == 1.0  # 0.5 s of the first run + 0.5 s of the second


def test_extract_ignores_sessions_outside_the_window(tmp_path):
    store = AudioStore(tmp_path)
    s = store.new_session(start_ms=1000)
    s.append(pcm(1, 5), recv_ms=2000)
    s.close()
    audio, covered = store.extract(10_000, 12_000)
    assert covered == 0 and not audio.any()


def test_voices_match_needs_score_and_margin(tmp_path):
    v = Voices(tmp_path / "voices.json")
    a, b = np.zeros(4, np.float32), np.zeros(4, np.float32)
    a[0], b[1] = 1, 1
    v.add("Dana Okafor", a, "t")
    v.add("Mira Castillo", b, "t")
    q = np.array([0.9, 0.1, 0, 0], np.float32)
    assert v.best_match(q, set(), 0.7, 0.05)[0] == "Dana Okafor"
    assert v.best_match(np.array([0.5, 0.5, 0, 0], np.float32), set(), 0.6, 0.05) is None  # too close to call
    assert v.best_match(q, {"Dana Okafor"}, 0.7, 0.05) is None
    assert v.delete("Dana Okafor") and not v.delete("Dana Okafor")


def test_letters():
    assert [letters(i) for i in (0, 1, 25, 26)] == ["A", "B", "Z", "AA"]


def test_received_reports_last_audio_and_seconds_since(tmp_path):
    store = AudioStore(tmp_path)
    t0 = 1_800_000_000_000
    s = store.new_session(start_ms=t0)
    s.append(pcm(2, 1), recv_ms=t0 + 2000)
    s.append(pcm(3, 1), recv_ms=t0 + 13000)  # resumes at 10 s
    s.close()
    last, total = store.received(0)
    assert last == t0 + 13000 and total == 5
    assert store.received(t0 + 11000) == (t0 + 13000, 2)
    assert store.received(0, t0 + 1000) == (t0 + 13000, 1)  # only audio before the bound
    assert AudioStore(tmp_path / "empty").received(0) == (None, 0)
