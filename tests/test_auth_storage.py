import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from eth_account import Account
from eth_account.messages import encode_defunct

import auth
import music_engine
import storage


class AuthStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_root_patch = patch.object(storage, "DATA_ROOT", Path(self.temp_dir.name))
        self.database_path_patch = patch.object(
            storage, "DATABASE_PATH", Path(self.temp_dir.name) / "test.sqlite3"
        )
        self.env_patch = patch.dict(
            os.environ, {"FROSTWAVE_ALLOWED_ORIGINS": "https://app.example"}
        )
        self.data_root_patch.start()
        self.database_path_patch.start()
        self.env_patch.start()
        self.was_initialized = storage._INITIALIZED
        storage._INITIALIZED = False

    def tearDown(self):
        storage._INITIALIZED = self.was_initialized
        self.env_patch.stop()
        self.database_path_patch.stop()
        self.data_root_patch.stop()
        self.temp_dir.cleanup()

    def test_wallet_challenge_creates_revocable_session_and_cannot_be_replayed(self):
        account = Account.create()
        address = account.address
        challenge = auth.create_challenge("https://app.example", address, 1)
        signature = "0x" + Account.sign_message(
            encode_defunct(text=challenge["message"]), account.key
        ).signature.hex()

        token, signer = auth.verify_signature(
            "https://app.example", address, challenge["nonce"], signature
        )
        self.assertEqual(signer.lower(), address.lower())
        self.assertEqual(auth.authenticate(f"Bearer {token}"), address.lower())

        auth.revoke(f"Bearer {token}")
        self.assertIsNone(auth.authenticate(f"Bearer {token}"))
        with self.assertRaisesRegex(ValueError, "already used"):
            auth.verify_signature(
                "https://app.example", address, challenge["nonce"], signature
            )

    def test_video_jobs_persist_without_exposing_wallet_or_request(self):
        address = "0x" + "12" * 20
        storage.create_job(
            {
                "id": "test-job",
                "address": address,
                "model": "Wan 2.1",
                "request": {"prompt": "A quiet lake"},
                "status": "queued",
                "progress": 0,
                "completed_clips": 0,
                "total_clips": 60,
                "message": "Waiting",
                "created_at": 1,
            }
        )

        job = storage.list_jobs(address)[0]
        public_job = storage.public_job(job)
        self.assertEqual(job["id"], "test-job")
        self.assertEqual(public_job["prompt"], "A quiet lake")
        self.assertNotIn("address", public_job)
        self.assertNotIn("request", public_job)

    def test_music_request_accepts_instrumental_and_validates_duration(self):
        request = music_engine.validate_request(
            {
                "prompt": "Gentle piano",
                "title": "Quiet morning",
                "genre": "Ambient",
                "duration": 120,
                "vocal_style": "Instrumental",
            }
        )
        self.assertEqual(request["lyrics"], "")
        with self.assertRaisesRegex(ValueError, "song length"):
            music_engine.validate_request(
                {
                    "prompt": "Gentle piano",
                    "title": "Quiet morning",
                    "genre": "Ambient",
                    "duration": 300,
                    "vocal_style": "Instrumental",
                }
            )

    def test_music_generation_uses_ace_step_keyword_api_and_persists_result(self):
        request = music_engine.validate_request(
            {
                "prompt": "A gentle melody",
                "title": "Quiet morning",
                "lyrics": "[verse]\nSunlight fills the room",
                "genre": "Ambient",
                "duration": 60,
                "vocal_style": "With vocals",
            }
        )
        storage.create_music_job(
            {
                "id": "music-job",
                "address": "0x" + "34" * 20,
                "request": request,
                "status": "queued",
                "message": "Waiting",
                "is_public": False,
                "created_at": 1,
            }
        )

        class FakePipeline:
            arguments = None

            def __call__(self, **kwargs):
                self.arguments = kwargs
                output_path = Path(kwargs["save_path"])
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"test wav")

        pipeline = FakePipeline()
        music_root = Path(self.temp_dir.name) / "music"
        with patch.object(music_engine, "MUSIC_ROOT", music_root), patch.object(
            music_engine, "get_pipeline", return_value=pipeline
        ):
            music_engine.render_music("music-job", request)

        self.assertEqual(pipeline.arguments["format"], "wav")
        self.assertEqual(pipeline.arguments["audio_duration"], 60)
        self.assertEqual(pipeline.arguments["lyrics"], request["lyrics"])
        self.assertTrue(pipeline.arguments["manual_seeds"].isdigit())
        self.assertFalse(pipeline.arguments["audio2audio_enable"])
        self.assertEqual(
            storage.get_music_job("music-job", "0x" + "34" * 20)["status"],
            "complete",
        )

        reference_id = "123e4567-e89b-12d3-a456-426614174000"
        reference_request = {**request, "reference_audio_id": reference_id}
        storage.create_music_job(
            {
                "id": "music-job-with-reference",
                "address": "0x" + "34" * 20,
                "request": reference_request,
                "status": "queued",
                "message": "Waiting",
                "is_public": False,
                "created_at": 2,
            }
        )
        reference_path = music_root / "references" / "reference.wav"
        reference_path.parent.mkdir(parents=True, exist_ok=True)
        reference_path.write_bytes(b"reference")
        with patch.object(music_engine, "MUSIC_ROOT", music_root), patch.object(
            music_engine, "get_pipeline", return_value=pipeline
        ):
            music_engine.render_music("music-job-with-reference", reference_request, reference_path)
        self.assertTrue(pipeline.arguments["audio2audio_enable"])
        self.assertEqual(pipeline.arguments["ref_audio_input"], str(reference_path))
        self.assertFalse(reference_path.exists())


if __name__ == "__main__":
    unittest.main()
