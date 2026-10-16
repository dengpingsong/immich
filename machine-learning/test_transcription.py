import logging

import pytest
from fastapi.testclient import TestClient

from immich_ml.transcription.backend import (
    TranscriptionError,
    TranscriptionResult,
    TranscriptionSegment,
    TranscriptionUnavailableError,
)
from immich_ml.transcription.main import TranscriptionSettings, create_app

SAMPLE_RATE = 16_000


def pcm(duration_ms: int, fill: int = 0) -> bytes:
    return b"\x00\x00" * int(duration_ms / 1000 * SAMPLE_RATE) if fill == 0 else bytes([fill, 0]) * int(
        duration_ms / 1000 * SAMPLE_RATE
    )


def entries(**overrides: object) -> str:
    payload = {
        "chunkIndex": 0,
        "offsetMs": 0,
        "durationMs": 1000,
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "languageHint": None,
    }
    payload.update(overrides)
    import json

    return json.dumps(payload)


class StubBackend:
    name = "stub:test"

    def __init__(self, result: TranscriptionResult | None = None, error: Exception | None = None) -> None:
        self.result = result or TranscriptionResult(language="zh", language_probability=0.9)
        self.error = error
        self.calls: list[tuple[int, str | None]] = []
        self.closed = 0

    def transcribe(self, audio: bytes, sample_rate: int, language: str | None) -> TranscriptionResult:
        if self.error:
            raise self.error
        self.calls.append((len(audio), language))
        return self.result

    def close(self) -> None:
        self.closed += 1


def client(backend: StubBackend | None = None, **settings: object) -> tuple[TestClient, list[StubBackend]]:
    created: list[StubBackend] = []

    def factory() -> StubBackend:
        backend_instance = backend or StubBackend()
        created.append(backend_instance)
        return backend_instance

    config = TranscriptionSettings(_env_file=None, **{"enabled": True, **settings})  # type: ignore[arg-type]
    return TestClient(create_app(config, backend_factory=factory)), created


def post(client: TestClient, audio: bytes, entries_json: str | None = None, headers: dict[str, str] | None = None):
    return client.post(
        "/transcribe",
        files={"audio": ("chunk.pcm", audio, "application/octet-stream")},
        data={"entries": entries_json or entries()},
        headers=headers or {},
    )


def test_health_reports_disabled_without_loading_a_model() -> None:
    http, created = client(backend=StubBackend(), enabled=False)
    body = http.get("/health").json()
    assert body["transcription"] == {
        "enabled": False,
        "loaded": False,
        "model": None,
        "maxConcurrency": 1,
        "borrowed": 0,
    }
    assert created == []


def test_disabled_worker_refuses_work() -> None:
    http, created = client(backend=StubBackend(), enabled=False)
    response = post(http, pcm(1000))
    assert response.status_code == 503
    assert created == []


def test_missing_optional_dependency_is_reported_as_unavailable() -> None:
    def factory() -> StubBackend:
        raise TranscriptionUnavailableError("not provisioned")

    config = TranscriptionSettings(enabled=True, _env_file=None)  # type: ignore[arg-type]
    http = TestClient(create_app(config, backend_factory=factory))
    response = post(http, pcm(1000))
    assert response.status_code == 503
    assert response.json()["detail"] == "not provisioned"


def test_api_key_is_required_before_reading_audio_when_configured() -> None:
    http, created = client(backend=StubBackend(), api_key="secret")
    assert post(http, pcm(1000)).status_code == 401
    assert post(http, pcm(1000), headers={"x-api-key": "wrong"}).status_code == 401
    # Auth must be rejected before multipart validation or buffering, so a body-less request is 401,
    # not the 422 that a missing field would otherwise produce.
    assert http.post("/transcribe", files={}, data={}).status_code == 401
    assert http.post("/transcribe", files={}, data={"entries": entries()}).status_code == 401
    assert created == []
    assert post(http, pcm(1000), headers={"x-api-key": "secret"}).status_code == 200


def test_returns_chunk_relative_segments_and_adds_no_offset() -> None:
    backend = StubBackend(
        TranscriptionResult(
            language="zh",
            language_probability=0.87,
            segments=[
                TranscriptionSegment(start=0.5, end=1.25, text="你好"),
                TranscriptionSegment(start=1.3, end=1.4, text="   "),
            ],
        ),
    )
    http, _ = client(backend=backend)
    response = post(http, pcm(2000), entries(offsetMs=30_000, durationMs=2000, chunkIndex=3))
    assert response.status_code == 200
    body = response.json()
    assert body["offsetMs"] == 30_000
    assert body["chunkIndex"] == 3
    assert body["status"] == "ok"
    assert body["model"] == "stub:test"
    # Segment times stay chunk-relative: the server owns the offset so it is added exactly once.
    assert body["segments"] == [
        {"startMs": 500, "endMs": 1250, "text": "你好", "noSpeechProbability": None, "avgLogprob": None},
    ]


def test_forwards_model_confidence_so_the_caller_can_drop_hallucinations() -> None:
    backend = StubBackend(
        TranscriptionResult(
            segments=[
                TranscriptionSegment(start=0, end=1, text="hallo", no_speech_prob=0.82, avg_logprob=-1.4),
                TranscriptionSegment(start=1, end=2, text="real", no_speech_prob=0.01, avg_logprob=-0.2),
            ],
        ),
    )
    http, _ = client(backend=backend)
    body = post(http, pcm(2000), entries(durationMs=2000)).json()
    # Both segments are returned; the caller decides what to render.
    assert [(s["text"], s["noSpeechProbability"], s["avgLogprob"]) for s in body["segments"]] == [
        ("hallo", 0.82, -1.4),
        ("real", 0.01, -0.2),
    ]


def test_silence_returns_no_speech_instead_of_hallucinated_text() -> None:
    http, _ = client(backend=StubBackend(TranscriptionResult(language="en", segments=[])))
    response = post(http, pcm(1000))
    assert response.status_code == 200
    assert response.json()["status"] == "no_speech"
    assert response.json()["segments"] == []


def test_language_hint_is_forwarded_for_later_chunks() -> None:
    backend = StubBackend()
    http, _ = client(backend=backend)
    post(http, pcm(1000), entries(languageHint="zh"))
    assert backend.calls == [(32_000, "zh")]


def test_clips_model_output_to_the_declared_window() -> None:
    backend = StubBackend(
        TranscriptionResult(
            segments=[TranscriptionSegment(start=0, end=99, text="long"), TranscriptionSegment(start=0, end=0, text="x")],
        ),
    )
    http, _ = client(backend=backend)
    body = post(http, pcm(1000), entries(durationMs=1000)).json()
    assert body["segments"] == [
        {"startMs": 0, "endMs": 1000, "text": "long", "noSpeechProbability": None, "avgLogprob": None},
    ]


def test_rejects_wrong_rate_channels_and_malformed_metadata() -> None:
    http, created = client(backend=StubBackend())
    assert post(http, pcm(1000), entries(sampleRate=44_100)).status_code == 422
    assert post(http, pcm(1000), entries(channels=2)).status_code == 422
    assert post(http, pcm(1000), '{"chunkIndex": 0}').status_code == 422
    assert post(http, pcm(1000), entries(durationMs=0)).status_code == 422
    assert post(http, pcm(1000), entries(durationMs=40_000)).status_code == 422
    assert post(http, pcm(1000), entries(offsetMs=-1)).status_code == 422
    assert post(http, b"").status_code == 422
    assert post(http, b"\x00").status_code == 422
    assert created == []


def test_rejects_oversized_or_overlong_audio() -> None:
    http, created = client(backend=StubBackend(), max_audio_bytes=32_000)
    assert post(http, pcm(2000)).status_code == 413
    # Declared window smaller than the uploaded audio: a mismatch must not be silently accepted.
    http2, _ = client(backend=StubBackend())
    assert post(http2, pcm(2000), entries(durationMs=1000)).status_code == 422
    assert created == []


def test_accepts_a_tail_chunk_shorter_than_the_declared_window() -> None:
    http, _ = client(backend=StubBackend())
    assert post(http, pcm(400), entries(durationMs=1000)).status_code == 200


def test_backend_failures_do_not_poison_the_loaded_model() -> None:
    backend = StubBackend(error=TranscriptionError("boom"))
    http, created = client(backend=backend)
    assert post(http, pcm(1000)).status_code == 500
    backend.error = None
    assert post(http, pcm(1000)).status_code == 200
    assert len(created) == 1


def test_arbitrary_backend_exception_becomes_a_chunk_scoped_error() -> None:
    http, _ = client(backend=StubBackend(error=RuntimeError("native crash")))
    assert post(http, pcm(1000)).status_code == 500


def test_model_is_loaded_once_and_reused_across_chunks() -> None:
    http, created = client(backend=StubBackend())
    for index in range(3):
        assert post(http, pcm(1000), entries(chunkIndex=index)).status_code == 200
    assert len(created) == 1
    assert http.get("/health").json()["transcription"]["loaded"] is True


def test_concurrency_limit_rejects_extra_work_instead_of_queueing() -> None:
    http, _ = client(backend=StubBackend(), max_concurrency=1)
    assert post(http, pcm(1000)).status_code == 200
    assert post(http, pcm(1000)).status_code == 200


def test_idle_unload_is_disabled_when_ttl_is_zero() -> None:
    backend = StubBackend()
    http, _ = client(backend=backend, idle_unload_s=0)
    post(http, pcm(1000))
    assert backend.closed == 0
    assert http.get("/health").json()["transcription"]["loaded"] is True


def test_unloads_only_when_idle() -> None:
    from immich_ml.transcription.service import TranscriptionService

    now = [0.0]
    backends: list[StubBackend] = []

    def factory() -> StubBackend:
        created = StubBackend()
        backends.append(created)
        return created

    service = TranscriptionService(factory, max_concurrency=1, idle_unload_s=10, clock=lambda: now[0])
    assert service.transcribe(b"\x00\x00" * 16, SAMPLE_RATE, None)[0] == "stub:test"
    now[0] = 5
    assert service.maybe_unload() is False
    now[0] = 20
    assert service.maybe_unload() is True
    assert backends[0].closed == 1
    assert service.status()["loaded"] is False
    # A later request reloads transparently rather than failing.
    assert service.transcribe(b"\x00\x00" * 16, SAMPLE_RATE, None)[0] == "stub:test"
    assert len(backends) == 2


def test_unload_never_closes_a_borrowed_model() -> None:
    from immich_ml.transcription.service import TranscriptionService

    now = [0.0]
    backend = StubBackend()
    service = TranscriptionService(lambda: backend, max_concurrency=2, idle_unload_s=1, clock=lambda: now[0])
    service._acquire_backend()  # noqa: SLF001 - deliberately simulating an in-flight request
    now[0] = 100
    assert service.maybe_unload() is False
    assert backend.closed == 0
    service._release_backend(backend)  # noqa: SLF001
    now[0] = 200
    assert service.maybe_unload() is True
    assert backend.closed == 1


def test_concurrent_first_requests_load_the_model_once() -> None:
    import threading

    from immich_ml.transcription.service import TranscriptionService

    started = threading.Barrier(4)
    loads = [0]

    def factory() -> StubBackend:
        loads[0] += 1
        return StubBackend()

    service = TranscriptionService(factory, max_concurrency=4, idle_unload_s=0)
    results: list[str] = []
    errors: list[Exception] = []

    def run() -> None:
        try:
            started.wait(timeout=5)
            results.append(service.transcribe(b"\x00\x00" * 16, SAMPLE_RATE, None)[0])
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert errors == []
    assert loads[0] == 1
    assert results == ["stub:test"] * 4


def test_busy_errors_do_not_load_a_model() -> None:
    from immich_ml.transcription.service import TranscriptionBusyError, TranscriptionService

    loads = [0]

    def factory() -> StubBackend:
        loads[0] += 1
        return StubBackend()

    service = TranscriptionService(factory, max_concurrency=1, idle_unload_s=0)
    service._slots.acquire()  # noqa: SLF001 - simulate a saturated worker
    try:
        try:
            service.transcribe(b"\x00\x00" * 16, SAMPLE_RATE, None)
            raise AssertionError("expected busy error")
        except TranscriptionBusyError:
            pass
    finally:
        service._slots.release()  # noqa: SLF001
    assert loads[0] == 0


def test_logs_do_not_contain_transcribed_text(caplog) -> None:
    http, _ = client(
        backend=StubBackend(
            TranscriptionResult(segments=[TranscriptionSegment(start=0, end=1, text="private sentence")]),
        ),
    )
    with caplog.at_level(logging.DEBUG):
        assert post(http, pcm(1000)).status_code == 200
    assert "private sentence" not in caplog.text


class TestResolveLocalModel:
    """Offline provisioning must work for a plain directory, a path, and the HF cache layout."""

    def test_plain_directory_inside_model_dir(self, tmp_path) -> None:
        from immich_ml.transcription.backend import resolve_local_model

        model = tmp_path / "small"
        model.mkdir()
        assert resolve_local_model("small", tmp_path) == model

    def test_absolute_path(self, tmp_path) -> None:
        from immich_ml.transcription.backend import resolve_local_model

        model = tmp_path / "elsewhere" / "tiny"
        model.mkdir(parents=True)
        assert resolve_local_model(str(model), tmp_path / "unused") == model

    def test_hugging_face_cache_layout_prefers_a_complete_snapshot(self, tmp_path) -> None:
        from immich_ml.transcription.backend import resolve_local_model

        snapshots = tmp_path / "models--Systran--faster-whisper-tiny" / "snapshots"
        broken = snapshots / "aaa"
        complete = snapshots / "bbb"
        broken.mkdir(parents=True)
        complete.mkdir(parents=True)
        (broken / "config.json").write_text("{}")
        (complete / "model.bin").write_bytes(b"weights")
        assert resolve_local_model("tiny", tmp_path) == complete

    def test_returns_none_when_nothing_is_provisioned(self, tmp_path) -> None:
        from immich_ml.transcription.backend import resolve_local_model

        assert resolve_local_model("tiny", tmp_path) is None
        empty = tmp_path / "models--Systran--faster-whisper-tiny" / "snapshots" / "rev"
        empty.mkdir(parents=True)
        assert resolve_local_model("tiny", tmp_path) is None

    def test_offline_backend_reports_the_missing_model_without_connecting(self, tmp_path) -> None:
        from immich_ml.transcription.backend import FasterWhisperBackend, TranscriptionUnavailableError

        with pytest.raises(TranscriptionUnavailableError, match="not provisioned"):
            FasterWhisperBackend(model="tiny", model_dir=tmp_path, allow_download=False)

    def test_offline_backend_loads_the_provisioned_directory(self, tmp_path) -> None:
        from unittest.mock import MagicMock, patch

        from immich_ml.transcription.backend import FasterWhisperBackend

        model = tmp_path / "tiny"
        model.mkdir()
        fake = MagicMock()
        with patch.dict("sys.modules", {"faster_whisper": MagicMock(WhisperModel=fake)}):
            backend = FasterWhisperBackend(model="tiny", model_dir=tmp_path, allow_download=False)
        assert fake.call_args.args[0] == str(model)
        assert fake.call_args.kwargs["local_files_only"] is True
        assert backend.name == "faster-whisper:tiny"
