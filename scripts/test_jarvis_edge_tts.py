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
            communicate.save.assert_awaited_once()
            actual_output = Path(communicate.save.await_args.args[0])
            self.assertEqual(actual_output.name, "voice.mp3")
            # Windows may expose the temp directory through either its 8.3
            # alias (RUNNER~1) or the expanded path. Compare directory identity
            # instead of string spelling so both refer to the same safe temp dir.
            self.assertTrue(actual_output.parent.samefile(Path(temp)))
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
