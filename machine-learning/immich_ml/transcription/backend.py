"""Optional Whisper-family transcription backends.

The dependency is deliberately optional and imported lazily: importing this module must never require
the ``whisper`` extra, so the existing vision service keeps working without it.
"""

from __future__ import annotations

import abc
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Whisper is trained on 16 kHz mono audio; the caller decodes and resamples before sending PCM.
SUPPORTED_SAMPLE_RATE = 16_000


class TranscriptionSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str
    # Model-provided confidence signals. Whisper hallucinates fluent text on music and noise, so these
    # are forwarded to the caller instead of being silently dropped or silently trusted.
    no_speech_prob: float | None = None
    avg_logprob: float | None = None


class TranscriptionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str | None = None
    language_probability: float | None = None
    segments: list[TranscriptionSegment] = Field(default_factory=list)


class TranscriptionError(RuntimeError):
    """Base class for backend failures that should fail the chunk instead of the whole worker."""


class TranscriptionUnavailableError(TranscriptionError):
    """The backend cannot serve requests (optional dependency or local model missing)."""


class TranscriptionBackend(abc.ABC):
    """One loaded model. Implementations must be safe to reuse across sequential chunks."""

    @property
    def name(self) -> str:
        raise NotImplementedError

    @abc.abstractmethod
    def transcribe(self, pcm: bytes, sample_rate: int, language: str | None) -> TranscriptionResult:
        """Transcribe mono PCM16 little-endian audio; segment times are relative to the buffer start."""

    def close(self) -> None:
        """Release native resources. Called only when no request is borrowing this backend."""


def resolve_local_model(model: str, model_dir: Path) -> Path | None:
    """Resolve an already provisioned model without any network access.

    Accepts either a plain model directory (an absolute path, or a name inside ``model_dir``) or the
    Hugging Face cache layout that ``snapshot_download`` produces, so operators can pre-seed models
    however they prefer. Returns ``None`` when nothing is provisioned locally.
    """
    candidate = Path(model)
    if not candidate.is_absolute():
        candidate = model_dir / model
    if candidate.is_dir():
        return candidate

    # Hugging Face cache: <model_dir>/models--<org>--<repo>/snapshots/<revision>/
    # Short names such as "tiny" resolve to the Systran/faster-whisper-* repositories, so accept both
    # the literal repository name and that short-name mapping.
    repo_dirs = {model_dir / f"models--{model.replace('/', '--')}"}
    if "/" not in model:
        repo_dirs.add(model_dir / f"models--Systran--faster-whisper-{model}")
    for repo_dir in sorted(repo_dirs):
        snapshots = repo_dir / "snapshots"
        if not snapshots.is_dir():
            continue
        revisions = [entry for entry in sorted(snapshots.iterdir()) if entry.is_dir() and any(entry.iterdir())]
        # Prefer a complete snapshot; an interrupted download leaves a directory without weights behind.
        revisions.sort(key=lambda entry: not (entry / "model.bin").is_file())
        if revisions:
            return revisions[0]
    return None


class FasterWhisperBackend(TranscriptionBackend):
    """faster-whisper/CTranslate2 backend.

    Offline by default: the model must already exist under ``model_dir``. Downloading is an explicit
    operator action (``allow_download``), never an implicit side effect of a transcription request.
    """

    def __init__(
        self,
        model: str,
        model_dir: Path,
        device: str = "cpu",
        compute_type: str = "int8",
        allow_download: bool = False,
        cpu_threads: int = 0,
    ) -> None:
        self._model_name = model
        self._model_dir = model_dir
        local_path = resolve_local_model(model, model_dir)
        if local_path is None and not allow_download:
            raise TranscriptionUnavailableError(
                f"Whisper model '{model}' is not provisioned in {model_dir} and downloads are disabled",
            )
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415 - optional dependency, imported lazily
        except ImportError as error:
            raise TranscriptionUnavailableError(
                "faster-whisper is not installed; install the machine-learning 'whisper' extra",
            ) from error

        source = str(local_path) if local_path is not None else model
        logger.info("Loading Whisper model %s from %s on %s (%s)", model, source, device, compute_type)
        self._model = WhisperModel(
            source,
            device=device,
            compute_type=compute_type,
            download_root=str(model_dir),
            local_files_only=not allow_download,
            cpu_threads=cpu_threads,
        )

    @property
    def name(self) -> str:
        return f"faster-whisper:{self._model_name}"

    def transcribe(self, pcm: bytes, sample_rate: int, language: str | None) -> TranscriptionResult:
        if sample_rate != SUPPORTED_SAMPLE_RATE:
            raise TranscriptionError(f"Unsupported sample rate {sample_rate}")
        try:
            import numpy as np  # noqa: PLC0415 - optional dependency, imported lazily
        except ImportError as error:  # pragma: no cover - numpy is a core dependency when installed
            raise TranscriptionUnavailableError("numpy is required to decode PCM audio") from error

        audio = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32_768.0
        segments, info = self._model.transcribe(
            audio,
            language=language,
            task="transcribe",
            # Every chunk is an independent request: prior-chunk conditioning would leak text across
            # chunk boundaries and encourage repetition loops on music or silence.
            condition_on_previous_text=False,
            # VAD filtering would delete real silence and shift every later timestamp.
            vad_filter=False,
        )
        return TranscriptionResult(
            language=getattr(info, "language", None),
            language_probability=_optional_float(getattr(info, "language_probability", None)),
            segments=[
                TranscriptionSegment(
                    start=segment.start,
                    end=segment.end,
                    text=segment.text,
                    no_speech_prob=_optional_float(getattr(segment, "no_speech_prob", None)),
                    avg_logprob=_optional_float(getattr(segment, "avg_logprob", None)),
                )
                for segment in segments
            ],
        )

    def close(self) -> None:
        self._model = None  # type: ignore[assignment]


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None
