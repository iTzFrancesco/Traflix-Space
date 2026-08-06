#!/usr/bin/env python3
"""Minimal Edge TTS helper.

The process receives exactly one JSON object on stdin and emits one bounded
JSON result. It has no access to Jarvis settings, workspace files or API keys.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path


def _result(ok: bool, **fields: object) -> None:
    payload = {"ok": ok, **fields}
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _safe_output_path(raw: object) -> Path:
    path = Path(str(raw or "")).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if temp_root not in path.parents or path.suffix.lower() != ".mp3":
        raise ValueError("output path is outside the temporary directory")
    return path


async def _speak(payload: dict[str, object]) -> None:
    try:
        import edge_tts  # type: ignore
    except ImportError:
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
    except Exception:
        _result(False, error="edge_tts_failed")


async def _list_voices() -> None:
    try:
        import edge_tts  # type: ignore
        voices = await edge_tts.list_voices()
        bounded = [
            {"shortName": str(item.get("ShortName", "")), "locale": str(item.get("Locale", "")), "gender": item.get("Gender")}
            for item in voices
            if str(item.get("Locale", "")).lower().startswith("it-")
        ][:64]
        _result(True, voices=bounded)
    except Exception:
        _result(False, error="edge_tts_voice_list_failed")


async def main() -> None:
    try:
        payload = json.loads(sys.stdin.readline())
        if not isinstance(payload, dict):
            raise ValueError("invalid request")
        if payload.get("action") == "listVoices":
            await _list_voices()
        else:
            await _speak(payload)
    except Exception:
        _result(False, error="invalid_request")


if __name__ == "__main__":
    asyncio.run(main())
