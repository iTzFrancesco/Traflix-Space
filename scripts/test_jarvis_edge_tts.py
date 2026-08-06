import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SCRIPT = Path(__file__).with_name("jarvis-edge-tts.py")
SPEC = importlib.util.spec_from_file_location("jarvis_edge_tts", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class HelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_helper_uses_mocked_edge_tts_without_network(self):
        fake = types.ModuleType("edge_tts")
        communicate = types.SimpleNamespace(save=AsyncMock())
        fake.Communicate = lambda *args, **kwargs: communicate
        with tempfile.TemporaryDirectory() as temp:
            output = str(Path(temp) / "voice.mp3")
            with patch.dict(sys.modules, {"edge_tts": fake}), patch("sys.stdout") as stdout:
                await MODULE._speak({"text": "Ciao Jarvis", "outputPath": output, "voice": "it-IT-DiegoNeural"})
            communicate.save.assert_awaited_once_with(output)
            payload = json.loads(stdout.write.call_args.args[0])
            self.assertTrue(payload["ok"])

    async def test_helper_rejects_path_outside_temp(self):
        fake = types.ModuleType("edge_tts")
        with patch.dict(sys.modules, {"edge_tts": fake}), patch("sys.stdout") as stdout:
            await MODULE._speak({"text": "Ciao", "outputPath": "/etc/voice.mp3"})
        payload = json.loads(stdout.write.call_args.args[0])
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
