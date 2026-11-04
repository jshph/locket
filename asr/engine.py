"""Speech models for the Omi speech service: Silero VAD, Parakeet TDT transcription, pyannote
segmentation + WeSpeaker embeddings for diarization, all sherpa-onnx on CPU. Audio is float32
mono at 16 kHz throughout."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sherpa_onnx

SR = 16000
MODELS = Path(os.environ.get("OMI_ASR_MODELS", Path(__file__).parent / "models"))
THREADS = int(os.environ.get("OMI_ASR_THREADS", "4"))
# Cosine distance threshold for joining clusters; higher merges more voices into one speaker.
CLUSTER_THRESHOLD = float(os.environ.get("OMI_DIARIZE_THRESHOLD", "0.45"))
MAX_ASR_SECONDS = 25.0


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


class Models:
    """Loaded once; each model is guarded by a lock because sherpa objects aren't re-entrant."""

    def __init__(self) -> None:
        p = MODELS / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
        self.asr = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(p / "encoder.int8.onnx"), decoder=str(p / "decoder.int8.onnx"),
            joiner=str(p / "joiner.int8.onnx"), tokens=str(p / "tokens.txt"),
            num_threads=THREADS, model_type="nemo_transducer",
        )
        emb = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(MODELS / "wespeaker_en_voxceleb_resnet34_LM.onnx"), num_threads=THREADS,
        )
        self.embedder = sherpa_onnx.SpeakerEmbeddingExtractor(emb)
        self.diar_config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx")),
                num_threads=THREADS,
            ),
            embedding=emb,
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=CLUSTER_THRESHOLD),
            min_duration_on=0.3, min_duration_off=0.5,
        )
        self.diarizer = sherpa_onnx.OfflineSpeakerDiarization(self.diar_config)
        self.asr_lock = threading.Lock()
        self.emb_lock = threading.Lock()
        self.diar_lock = threading.Lock()

    def new_vad(self) -> sherpa_onnx.VoiceActivityDetector:
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(MODELS / "silero_vad.onnx")
        cfg.silero_vad.threshold = 0.5
        cfg.silero_vad.min_silence_duration = 0.6
        cfg.silero_vad.min_speech_duration = 0.25
        cfg.silero_vad.max_speech_duration = MAX_ASR_SECONDS
        cfg.sample_rate = SR
        cfg.num_threads = 1
        return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)

    def transcribe(self, samples: np.ndarray) -> str:
        with self.asr_lock:
            s = self.asr.create_stream()
            s.accept_waveform(SR, samples)
            self.asr.decode_stream(s)
            return s.result.text.strip()

    def embed(self, samples: np.ndarray) -> np.ndarray | None:
        if len(samples) < SR * 0.8:  # too short for a stable voiceprint
            return None
        with self.emb_lock:
            s = self.embedder.create_stream()
            s.accept_waveform(SR, samples)
            s.input_finished()
            v = np.array(self.embedder.compute(s), dtype=np.float32)
        n = np.linalg.norm(v)
        return v / n if n > 0 else None

    def diarize(self, samples: np.ndarray) -> list[tuple[float, float, int]]:
        with self.diar_lock:
            result = self.diarizer.process(samples).sort_by_start_time()
        return [(seg.start, seg.end, seg.speaker) for seg in result]


@dataclass
class Turn:
    start: float
    end: float
    speaker: int
    text: str = ""


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
