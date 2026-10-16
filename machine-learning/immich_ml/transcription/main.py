"""Internal transcription worker.

Runs as its own process/container so heavy native ASR inference can be cancelled by killing the
container instead of hoping an HTTP timeout stops it, and so the optional Whisper dependency never
touches the vision worker. It is not a user-facing API: it has no asset permissions of its own and
must only be reachable from the Immich server.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from .backend import FasterWhisperBackend, TranscriptionBackend, TranscriptionUnavailableError
from .service import (
    TranscriptionBusyError,
    TranscriptionDisabledError,
    TranscriptionService,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# One chunk is at most 32s of 16 kHz mono PCM16 plus slack; anything larger is a caller bug or abuse.
MAX_CHUNK_MS = 32_000
DURATION_TOLERANCE_MS = 100


class TranscriptionSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MACHINE_LEARNING_TRANSCRIPTION_",
        case_sensitive=False,
        env_nested_delimiter="__",
        protected_namespaces=("settings_",),
    )

    enabled: bool = False
    model: str = "small"
    model_dir: Path = (Path.home() / ".cache" / "immich_whisper").resolve()
    device: str = "cpu"
    compute_type: str = "int8"
    cpu_threads: int = 0
    allow_download: bool = False
    max_concurrency: int = 1
    idle_unload_s: int = 300
    max_audio_bytes: int = 2 * 1024 * 1024
    sample_rate: int = 16_000
    api_key: str | None = None


class ChunkRequest(BaseModel):
    """Chunk-relative metadata. Times are relative to the start of the uploaded PCM window."""

    model_config = ConfigDict(extra="forbid")

    chunkIndex: int = Field(ge=0)
    offsetMs: int = Field(ge=0)
    durationMs: int = Field(gt=0, le=MAX_CHUNK_MS)
    sampleRate: int = Field(gt=0)
    channels: int = Field(gt=0)
    languageHint: str | None = None


class SegmentResponse(BaseModel):
    startMs: int
    endMs: int
    text: str
    noSpeechProbability: float | None = None
    avgLogprob: float | None = None


class TranscribeResponse(BaseModel):
    chunkIndex: int
    offsetMs: int
    durationMs: int
    status: str
    language: str | None
    languageProbability: float | None
    model: str
    segments: list[SegmentResponse]


def create_app(
    settings: TranscriptionSettings | None = None,
    backend_factory: Any = None,
) -> FastAPI:
    config = settings or TranscriptionSettings()

    def build_backend() -> TranscriptionBackend:
        if backend_factory is not None:
            return backend_factory()
        return FasterWhisperBackend(
            model=config.model,
            model_dir=config.model_dir,
            device=config.device,
            compute_type=config.compute_type,
            allow_download=config.allow_download,
            cpu_threads=config.cpu_threads,
        )

    service = TranscriptionService(
        build_backend,
        enabled=config.enabled,
        max_concurrency=config.max_concurrency,
        idle_unload_s=config.idle_unload_s,
    )
    app = FastAPI(title="Immich transcription worker", docs_url=None, redoc_url=None)

    def authorize(x_api_key: Annotated[str | None, Header()] = None) -> None:
        # A dependency runs before FastAPI validates or reads the multipart body, so an unauthenticated
        # caller cannot make this worker buffer audio. Checked inline in the handler it would come too
        # late: a missing field would already have produced a 422.
        if config.api_key is not None and x_api_key != config.api_key:
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"status": "ok", "transcription": service.status()}

    @app.post("/transcribe", response_model=TranscribeResponse)
    async def transcribe(
        entries: Annotated[str, Form()],
        audio: Annotated[UploadFile, File()],
        _authorized: None = Depends(authorize),
    ) -> TranscribeResponse:
        if not service.enabled:
            raise HTTPException(status_code=503, detail="Transcription is disabled")

        try:
            request = ChunkRequest.model_validate_json(entries)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=error.errors(include_url=False)) from error

        if request.sampleRate != config.sample_rate or request.channels != 1:
            raise HTTPException(
                status_code=422,
                detail=f"Expected {config.sample_rate} Hz mono PCM16",
            )

        pcm = await audio.read(config.max_audio_bytes + 1)
        if len(pcm) > config.max_audio_bytes:
            raise HTTPException(status_code=413, detail="Audio chunk too large")
        if len(pcm) == 0 or len(pcm) % 2 != 0:
            raise HTTPException(status_code=422, detail="Audio must be a non-empty PCM16 buffer")

        decoded_ms = math.floor(len(pcm) / 2 / config.sample_rate * 1000)
        if decoded_ms > request.durationMs + DURATION_TOLERANCE_MS:
            raise HTTPException(status_code=422, detail="Audio is longer than the declared window")

        try:
            model, result = service.transcribe(pcm, request.sampleRate, request.languageHint)
        except TranscriptionDisabledError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except TranscriptionBusyError as error:
            raise HTTPException(status_code=429, detail=str(error)) from error
        except TranscriptionUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except Exception as error:  # noqa: BLE001 - backend failures become a chunk-level 500
            logger.exception("Transcription failed for chunk %s", request.chunkIndex)
            raise HTTPException(status_code=500, detail="Transcription failed") from error

        segments = [
            SegmentResponse(
                startMs=max(0, min(request.durationMs, round(segment.start * 1000))),
                endMs=max(0, min(request.durationMs, round(segment.end * 1000))),
                text=segment.text,
                noSpeechProbability=segment.no_speech_prob,
                avgLogprob=segment.avg_logprob,
            )
            for segment in result.segments
        ]
        segments = [segment for segment in segments if segment.text.strip() and segment.endMs > segment.startMs]
        return TranscribeResponse(
            chunkIndex=request.chunkIndex,
            offsetMs=request.offsetMs,
            durationMs=request.durationMs,
            status="ok" if segments else "no_speech",
            language=result.language,
            languageProbability=result.language_probability,
            model=model,
            segments=segments,
        )

    return app


app = create_app()
