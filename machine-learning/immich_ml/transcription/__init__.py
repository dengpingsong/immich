"""Explicit opt-in Whisper-family transcription worker (disabled by default).

Run it as a separate container from the vision worker:

    uvicorn immich_ml.transcription.main:app --host 0.0.0.0 --port 3004

It requires the optional ``whisper`` extra and an already provisioned local model. It never downloads
models implicitly, and it is designed to be reachable only from the Immich server.
"""

from .backend import (
    FasterWhisperBackend,
    TranscriptionBackend,
    TranscriptionError,
    TranscriptionResult,
    TranscriptionSegment,
    TranscriptionUnavailableError,
    resolve_local_model,
)
from .service import (
    TranscriptionBusyError,
    TranscriptionDisabledError,
    TranscriptionService,
)

__all__ = [
    "FasterWhisperBackend",
    "TranscriptionBackend",
    "TranscriptionBusyError",
    "TranscriptionDisabledError",
    "TranscriptionError",
    "TranscriptionResult",
    "TranscriptionSegment",
    "TranscriptionService",
    "TranscriptionUnavailableError",
    "resolve_local_model",
]
