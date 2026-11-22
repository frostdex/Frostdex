import math
import unittest

from server import MODEL_IDS, VIDEO_SECONDS, dimensions_for, validate_request


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


if __name__ == "__main__":
    unittest.main()
