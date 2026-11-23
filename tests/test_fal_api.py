import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fal_api


class FalApiTests(unittest.TestCase):
    def test_submit_waits_for_queue_completion_and_returns_result(self):
        queued = {
            "status_url": "https://queue.fal.run/model/requests/id/status",
            "response_url": "https://queue.fal.run/model/requests/id",
        }
        with patch.dict("os.environ", {"FAL_KEY": "test-key"}), patch.object(
            fal_api,
            "_request_json",
            side_effect=[queued, {"status": "IN_PROGRESS"}, {"status": "COMPLETED"}, {"video": {"url": "https://v3b.fal.media/video.mp4"}}],
        ) as request_json, patch.object(fal_api.time, "sleep"):
            result = fal_api.submit_and_wait("model", {"prompt": "A sunrise"})

        self.assertIn("video", result)
        self.assertEqual(request_json.call_args_list[0].kwargs["method"], "POST")
        self.assertEqual(request_json.call_args_list[0].kwargs["payload"], {"prompt": "A sunrise"})

    def test_rejects_queue_urls_outside_fal(self):
        with self.assertRaisesRegex(RuntimeError, "unexpected queue URL"):
            fal_api._queue_url("https://example.com/steal")

    def test_downloads_media_within_size_limit(self):
        class FakeResponse:
            headers = {"Content-Length": "4"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _size=-1):
                if self.sent:
                    return b""
                self.sent = True
                return b"data"

            sent = False

        with tempfile.TemporaryDirectory() as temporary_directory, patch.object(
            fal_api, "urlopen", return_value=FakeResponse()
        ):
            destination = Path(temporary_directory) / "output.mp4"
            fal_api.download_file("https://v3b.fal.media/video.mp4", destination, 4)
            self.assertEqual(destination.read_bytes(), b"data")
            self.assertFalse(destination.with_suffix(".mp4.part").exists())

    def test_rejects_unexpected_media_hosts(self):
        with self.assertRaisesRegex(RuntimeError, "unexpected media URL"):
            fal_api._media_url("https://localhost/private")


if __name__ == "__main__":
    unittest.main()
