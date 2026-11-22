import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import music_engine
from server import MODEL_IDS, VIDEO_SECONDS, audio_upload_extension, dimensions_for, validate_request


class VideoGeneratorTests(unittest.TestCase):
    def test_all_generators_make_a_five_minute_sequence(self):
        for model_key, config in MODEL_IDS.items():
            with self.subTest(model=model_key):
                clip_seconds = (config["frames"] - 1) / config["fps"]
                self.assertGreaterEqual(math.ceil(VIDEO_SECONDS / clip_seconds) * clip_seconds, 300)

    def test_portrait_dimensions_are_valid_for_each_generator(self):
        for model_key in MODEL_IDS:
            with self.subTest(model=model_key):
                width, height = dimensions_for(model_key, "portrait")
                self.assertGreater(height, width)
                self.assertEqual(width % 16, 0)
                self.assertEqual(height % 16, 0)

    def test_rejects_unavailable_models_and_malformed_prompts(self):
        base = {"prompt": "A story about a quiet mountain lake.", "format": "landscape", "style": "Cinematic"}
        with self.assertRaisesRegex(ValueError, "available local AI generators"):
            validate_request({**base, "model": "hosted-unlimited"})
        with self.assertRaisesRegex(ValueError, "Describe the video"):
            validate_request({**base, "model": "wan21-fast", "prompt": " "})
        with self.assertRaisesRegex(ValueError, "available local AI generators"):
            validate_request({**base, "model": ["wan21-fast"]})

    def test_normalizes_and_accepts_a_supported_generator(self):
        request = validate_request({
            "prompt": "  A quiet mountain lake at sunrise.  ",
            "model": "cogvideo-2b",
            "format": "portrait",
            "style": "Dreamlike",
        })
        self.assertEqual(request["prompt"], "A quiet mountain lake at sunrise.")
        self.assertEqual(request["model"], "cogvideo-2b")


class AudioUploadTests(unittest.TestCase):
    def test_detects_supported_audio_signatures(self):
        samples = {
            "wav": b"RIFF\x00\x00\x00\x00WAVE",
            "flac": b"fLaC",
            "ogg": b"OggS",
            "mp3": b"ID3\x04",
        }
        for expected, data in samples.items():
            with self.subTest(format=expected):
                self.assertEqual(audio_upload_extension(data), expected)

    def test_rejects_non_audio_files_and_oversized_uploads(self):
        with self.assertRaisesRegex(ValueError, "WAV, MP3, FLAC, or OGG"):
            audio_upload_extension(b"not audio")
        with patch("server.MAX_AUDIO_UPLOAD_BYTES", 8):
            with self.assertRaisesRegex(ValueError, "32 MB or smaller"):
                audio_upload_extension(b"RIFF\x00\x00\x00\x00WAVE")

    def test_reference_audio_is_owner_scoped_and_has_bounded_duration(self):
        reference_id = "123e4567-e89b-12d3-a456-426614174000"
        request = {
            "prompt": "A gentle song",
            "title": "Gentle song",
            "lyrics": "A little melody",
            "genre": "Indie",
            "duration": 90,
            "vocal_style": "With vocals",
            "is_public": False,
            "reference_audio_id": reference_id,
        }
        validated = music_engine.validate_request(request)
        self.assertEqual(validated["duration"], 90)
        self.assertEqual(validated["reference_audio_id"], reference_id)

        with self.assertRaisesRegex(ValueError, "uploaded reference audio is invalid"):
            music_engine.validate_request({**request, "reference_audio_id": "../other-user"})
        with self.assertRaisesRegex(ValueError, "1–240 seconds"):
            music_engine.validate_request({**request, "duration": 241})

        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            music_engine, "MUSIC_ROOT", Path(temp_dir)
        ):
            owner_directory = music_engine.audio_reference_directory("0x1234")
            owner_directory.mkdir(parents=True)
            owner_path = owner_directory / f"{reference_id}.wav"
            owner_path.write_bytes(b"audio")
            self.assertEqual(music_engine.find_audio_reference("0x1234", reference_id), owner_path)
            self.assertIsNone(music_engine.find_audio_reference("0x5678", reference_id))
            self.assertNotEqual(
                owner_directory,
                music_engine.audio_reference_directory("0x5678"),
            )


if __name__ == "__main__":
    unittest.main()
