#!/usr/bin/env python3
"""Minimal persistent Edge TTS helper.

The process reads one bounded JSON request per stdin line and emits exactly one
bounded JSON result per request. It has no access to Jarvis settings, workspace
files or API keys. Keeping the process alive avoids paying Python/PyInstaller
startup and import cost for every spoken reply.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from types import ModuleType

_EDGE_TTS: ModuleType | None = None


def _result(ok: bool, **fields: object) -> None:
    payload = {"ok": ok, **fields}
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _load_edge_tts() -> ModuleType | None:
    global _EDGE_TTS
    if _EDGE_TTS is not None:
        return _EDGE_TTS
    try:
        import edge_tts  # type: ignore
    except ImportError:
        return None
    _EDGE_TTS = edge_tts
    return _EDGE_TTS


def _safe_output_path(raw: object) -> Path:
    path = Path(str(raw or "")).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if temp_root not in path.parents or path.suffix.lower() != ".mp3":
        raise ValueError("output path is outside the temporary directory")
    return path


def _synthesis_error_code(error: Exception) -> str:
    module = type(error).__module__.lower()
    if isinstance(error, (TimeoutError, ConnectionError)) or module.startswith(
        ("aiohttp", "asyncio")
    ):
        return "edge_tts_network_failed"
    if isinstance(error, OSError):
        return "edge_tts_output_file_failed"
    return "edge_tts_failed"


async def _speak(payload: dict[str, object]) -> None:
    edge_tts = _load_edge_tts()
    if edge_tts is None:
        _result(False, error="edge_tts_unavailable")
        return

    text = str(payload.get("text", "")).strip()
    if not text or len(text) > 800:
        _result(False, error="invalid_text")
        return
    try:
        output_path = _safe_output_path(payload.get("outputPath"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        communicate = edge_tts.Communicate(
            text,
            str(payload.get("voice") or "it-IT-DiegoNeural"),
            rate=str(payload.get("rate") or "+0%"),
            volume=str(payload.get("volume") or "+0%"),
            pitch=str(payload.get("pitch") or "+0Hz"),
        )
        await communicate.save(str(output_path))
        _result(True, outputPath=str(output_path))
    except Exception as error:
        # Never return the exception message: network/library errors can carry
        # request details. The stable code is enough for safe diagnostics.
        _result(False, error=_synthesis_error_code(error))


async def _list_voices() -> None:
    edge_tts = _load_edge_tts()
    if edge_tts is None:
        _result(False, error="edge_tts_unavailable")
        return
    try:
        voices = await edge_tts.list_voices()
        bounded = [
            {
                "shortName": str(item.get("ShortName", "")),
                "locale": str(item.get("Locale", "")),
                "gender": item.get("Gender"),
            }
            for item in voices
            if str(item.get("Locale", "")).lower().startswith("it-")
        ][:64]
        _result(True, voices=bounded)
    except Exception as error:
        module = type(error).__module__.lower()
        code = (
            "edge_tts_voice_list_network_failed"
            if isinstance(error, (TimeoutError, ConnectionError))
            or module.startswith(("aiohttp", "asyncio"))
            else "edge_tts_voice_list_failed"
        )
        _result(False, error=code)


async def _handle(payload: dict[str, object]) -> bool:
    action = payload.get("action")
    if action == "quit":
        _result(True)
        return False
    if action == "ping":
        if _load_edge_tts() is None:
            _result(False, error="edge_tts_unavailable")
        else:
            _result(True)
        return True
    if action == "listVoices":
        await _list_voices()
    else:
        await _speak(payload)
    return True


async def main() -> None:
    # Requests are intentionally serialized. Jarvis only has one spoken reply
    # at a time, and sequential processing keeps cancellation/process ownership
    # simple while retaining the warm interpreter and imported edge_tts module.
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError("invalid request")
            if not await _handle(payload):
                break
        except Exception:
            _result(False, error="invalid_request")


if __name__ == "__main__":
    asyncio.run(main())
