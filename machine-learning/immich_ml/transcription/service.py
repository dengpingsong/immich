"""Single-flight model loading, bounded concurrency, and idle unloading for transcription."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .backend import TranscriptionBackend, TranscriptionError, TranscriptionResult

logger = logging.getLogger(__name__)


class TranscriptionDisabledError(TranscriptionError):
    pass


class TranscriptionBusyError(TranscriptionError):
    pass


class TranscriptionService:
    """Owns the loaded backend.

    Design rules that the tests pin down:
    - At most one load happens at a time, even under concurrent first requests.
    - Concurrency is capped; excess requests fail fast with a busy error instead of queueing unbounded work.
    - The model is unloaded when idle past the TTL, but never while a request is borrowing it.
    - A failed load must not leave a broken cache entry behind.
    """

    def __init__(
        self,
        factory: Callable[[], TranscriptionBackend],
        *,
        enabled: bool = True,
        max_concurrency: int = 1,
        idle_unload_s: int = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be at least 1")
        self._factory = factory
        self._enabled = enabled
        self._max_concurrency = max_concurrency
        self._idle_unload_s = idle_unload_s
        self._clock = clock
        self._load_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(max_concurrency)
        self._backend: TranscriptionBackend | None = None
        self._borrowed = 0
        self._last_used = clock()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def status(self) -> dict[str, object]:
        with self._state_lock:
            backend = self._backend
            return {
                "enabled": self._enabled,
                "loaded": backend is not None,
                "model": backend.name if backend else None,
                "maxConcurrency": self._max_concurrency,
                "borrowed": self._borrowed,
            }

    def transcribe(self, pcm: bytes, sample_rate: int, language: str | None) -> tuple[str, TranscriptionResult]:
        if not self._enabled:
            raise TranscriptionDisabledError("Transcription is disabled")
        if not self._slots.acquire(blocking=False):
            raise TranscriptionBusyError("Transcription worker is busy")
        backend: TranscriptionBackend | None = None
        try:
            backend = self._acquire_backend()
            try:
                result = backend.transcribe(pcm, sample_rate, language)
            except TranscriptionError:
                raise
            except Exception as error:  # noqa: BLE001 - native backends raise arbitrary exception types
                raise TranscriptionError(str(error)) from error
            return backend.name, result
        finally:
            self._release_backend(backend)
            self._slots.release()
            self.maybe_unload()

    def _acquire_backend(self) -> TranscriptionBackend:
        # Fast path: an already loaded model is reused, still counted as borrowed for TTL safety.
        with self._state_lock:
            if self._backend is not None:
                self._borrowed += 1
                self._last_used = self._clock()
                return self._backend
        with self._load_lock:
            with self._state_lock:
                if self._backend is not None:
                    self._borrowed += 1
                    self._last_used = self._clock()
                    return self._backend
            # Loading happens outside the state lock so other chunks can finish without blocking TTL checks.
            backend = self._factory()
            with self._state_lock:
                self._backend = backend
                self._borrowed += 1
                self._last_used = self._clock()
            return backend

    def _release_backend(self, backend: TranscriptionBackend | None) -> None:
        if backend is None:
            return
        with self._state_lock:
            self._borrowed = max(0, self._borrowed - 1)
            self._last_used = self._clock()

    def maybe_unload(self) -> bool:
        """Unload only when idle past the TTL; a borrowed model is never closed under a request."""
        with self._state_lock:
            backend = self._backend
            if backend is None or self._borrowed > 0:
                return False
            if self._idle_unload_s <= 0 or self._clock() - self._last_used < self._idle_unload_s:
                return False
            self._backend = None
        logger.info("Unloading idle transcription model %s", backend.name)
        try:
            backend.close()
        except Exception:  # noqa: BLE001 - unloading is best-effort cleanup
            logger.exception("Failed to close transcription backend")
        return True

    def shutdown(self) -> None:
        with self._state_lock:
            backend = self._backend
            self._backend = None
        if backend is not None:
            try:
                backend.close()
            except Exception:  # noqa: BLE001 - unloading is best-effort cleanup
                logger.exception("Failed to close transcription backend")
