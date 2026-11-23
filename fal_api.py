from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


VIDEO_MODEL = "minimax/h3-max/text-to-video"
MUSIC_MODEL = "fal-ai/ace-step"
QUEUE_ROOT = "https://queue.fal.run"
MAX_WAIT_SECONDS = 30 * 60
POLL_INTERVAL_SECONDS = 3
MAX_VIDEO_BYTES = 100 * 1024 * 1024
MAX_AUDIO_BYTES = 100 * 1024 * 1024


def is_configured() -> bool:
    return bool(os.environ.get("FAL_KEY", "").strip())


def _error_message(body: bytes, status: int) -> str:
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload.get("error") or payload.get("message")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()[:1000]
    return f"fal.ai returned HTTP {status}."


def _request_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    api_key = os.environ.get("FAL_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Fal.ai isn't configured. Add FAL_KEY to the backend environment and restart it.")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Key {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            response_body = response.read(1024 * 1024 + 1)
    except HTTPError as error:
        raise RuntimeError(_error_message(error.read(4096), error.code)) from error
    except (TimeoutError, URLError) as error:
        raise RuntimeError("Couldn't connect to fal.ai. Check the backend's internet connection and try again.") from error
    if len(response_body) > 1024 * 1024:
        raise RuntimeError("fal.ai returned an unexpectedly large API response.")
    try:
        result = json.loads(response_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError("fal.ai returned an invalid response.") from error
    if not isinstance(result, dict):
        raise RuntimeError("fal.ai returned an invalid response.")
    return result


def _queue_url(value: Any) -> str:
    if not isinstance(value, str):
        raise RuntimeError("fal.ai didn't return a valid queue URL.")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "queue.fal.run"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise RuntimeError("fal.ai returned an unexpected queue URL.")
    return value


def submit_and_wait(
    model: str,
    payload: dict[str, Any],
    on_update: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if not is_configured():
        raise RuntimeError("Fal.ai isn't configured. Add FAL_KEY to the backend environment and restart it.")
    model_path = quote(model, safe="/")
    submission = _request_json(f"{QUEUE_ROOT}/{model_path}", method="POST", payload=payload)
    status_url = _queue_url(submission.get("status_url"))
    response_url = _queue_url(submission.get("response_url"))
    deadline = time.monotonic() + MAX_WAIT_SECONDS
    while time.monotonic() < deadline:
        status = _request_json(status_url)
        state = status.get("status")
        if state == "COMPLETED":
            return _request_json(response_url)
        if state in {"FAILED", "CANCELLED"}:
            raise RuntimeError(_error_message(json.dumps(status).encode("utf-8"), 502))
        if on_update:
            on_update(state if isinstance(state, str) else "IN_PROGRESS")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError("fal.ai is taking too long to finish this request. Check again later.")


def _media_url(value: Any) -> str:
    if not isinstance(value, str):
        raise RuntimeError("fal.ai didn't return a media URL.")
    parsed = urlsplit(value)
    host = parsed.hostname.lower() if parsed.hostname else ""
    allowed_host = host == "fal.media" or host.endswith(".fal.media") or host == "storage.googleapis.com"
    if (
        parsed.scheme != "https"
        or not allowed_host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise RuntimeError("fal.ai returned an unexpected media URL.")
    return value


def download_file(url: Any, destination: Path, max_bytes: int) -> None:
    media_url = _media_url(url)
    temporary_path = destination.with_suffix(destination.suffix + ".part")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urlopen(Request(media_url), timeout=60) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise RuntimeError("The generated file is larger than the allowed size.")
            written = 0
            with temporary_path.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise RuntimeError("The generated file is larger than the allowed size.")
                    output.write(chunk)
        if written == 0:
            raise RuntimeError("fal.ai returned an empty media file.")
        temporary_path.replace(destination)
    except (HTTPError, TimeoutError, URLError, OSError, ValueError) as error:
        temporary_path.unlink(missing_ok=True)
        if isinstance(error, (HTTPError, TimeoutError, URLError)):
            raise RuntimeError("Couldn't download the generated file from fal.ai.") from error
        raise
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
