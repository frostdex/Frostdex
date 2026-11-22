from __future__ import annotations

import gc
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("FROSTWAVE_DATA_DIR", Path.home() / ".frostwave"))
VIDEO_ROOT = DATA_ROOT / "videos"
MODEL_IDS = {
    "wan21-fast": {
        "label": "Wan 2.1 · 1.3B",
        "repo": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
        "family": "wan",
        "width": 832,
        "height": 480,
        "frames": 81,
        "fps": 16,
        "steps": 30,
        "guidance": 5.0,
        "offload": "model",
    },
    "wan21-quality": {
        "label": "Wan 2.1 · 14B",
        "repo": "Wan-AI/Wan2.1-T2V-14B-Diffusers",
        "family": "wan",
        "width": 832,
        "height": 480,
        "frames": 81,
        "fps": 16,
        "steps": 30,
        "guidance": 5.0,
        "offload": "model",
    },
    "wan22-latest": {
        "label": "Wan 2.2 · A14B",
        "repo": "Wan-AI/Wan2.2-T2V-A14B-Diffusers",
        "family": "wan",
        "width": 832,
        "height": 480,
        "frames": 81,
        "fps": 16,
        "steps": 30,
        "guidance": 5.0,
        "offload": "model",
    },
    "cogvideo-2b": {
        "label": "CogVideoX · 2B",
        "repo": "THUDM/CogVideoX-2b",
        "family": "cogvideo",
        "width": 720,
        "height": 480,
        "frames": 49,
        "fps": 8,
        "steps": 50,
        "guidance": 6.0,
        "offload": "sequential",
    },
    "cogvideo-5b": {
        "label": "CogVideoX · 5B",
        "repo": "THUDM/CogVideoX-5b",
        "family": "cogvideo",
        "width": 768,
        "height": 480,
        "frames": 81,
        "fps": 16,
        "steps": 50,
        "guidance": 6.0,
        "offload": "model",
    },
}
VIDEO_SECONDS = 300
STYLE_PROMPTS = {
    "Cinematic": "Cinematic lighting, deliberate camera movement, film-like color grading",
    "Hand-drawn animation": "Hand-drawn animated film, expressive linework, cohesive illustrated frames",
    "Dreamlike": "Dreamlike atmosphere, soft light, surreal but coherent visual details",
    "Documentary": "Natural documentary cinematography, realistic lighting and camera movement",
    "Stop motion": "Tactile stop-motion animation, handcrafted miniature textures",
    "Photoreal": "Photorealistic imagery, natural materials and believable movement",
}
ASPECT_RATIOS = {"landscape", "portrait", "square"}
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
PIPELINE_LOCK = threading.Lock()
PIPELINE: Any = None
PIPELINE_MODEL: str | None = None
WORKERS = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-render")


def dimensions_for(model_key: str, aspect_ratio: str) -> tuple[int, int]:
    config = MODEL_IDS[model_key]
    width = int(config["width"])
    height = int(config["height"])
    if aspect_ratio == "portrait":
        return height, width
    if aspect_ratio == "square":
        return 480, 480
    return width, height


def validate_request(payload: Any) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Describe the video you want to make.")
    if len(prompt.strip()) > 1000:
        raise ValueError("Video descriptions must be 1,000 characters or fewer.")
    model = payload.get("model")
    if not isinstance(model, str) or model not in MODEL_IDS:
        raise ValueError("Choose one of the available local AI generators.")
    aspect_ratio = payload.get("format")
    if not isinstance(aspect_ratio, str) or aspect_ratio not in ASPECT_RATIOS:
        raise ValueError("Choose landscape, portrait, or square format.")
    style = payload.get("style")
    if not isinstance(style, str) or style not in STYLE_PROMPTS:
        raise ValueError("Choose one of the available visual styles.")
    return {
        "prompt": prompt.strip(),
        "model": model,
        "format": aspect_ratio,
        "style": style,
    }


def runtime_status() -> dict[str, Any]:
    try:
        import torch
    except ImportError:
        return {
            "ready": False,
            "gpu": None,
            "message": "PyTorch is missing. Install a CUDA-enabled PyTorch build, then restart the local engine.",
        }
    except Exception as error:
        return {"ready": False, "gpu": None, "message": f"PyTorch couldn't start: {error}"}

    try:
        if not torch.cuda.is_available():
            return {
                "ready": False,
                "gpu": None,
                "message": "No CUDA GPU found. This local generator needs a supported NVIDIA GPU.",
            }
        return {
            "ready": True,
            "gpu": torch.cuda.get_device_name(0),
            "message": "Local GPU ready. Model weights download the first time you use each generator.",
        }
    except Exception as error:
        return {"ready": False, "gpu": None, "message": f"CUDA couldn't initialize: {error}"}


def update_job(job_id: str, **updates: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.update(updates)


def get_pipeline(model_key: str) -> tuple[Any, Any]:
    global PIPELINE, PIPELINE_MODEL
    import torch

    with PIPELINE_LOCK:
        if PIPELINE is not None and PIPELINE_MODEL == model_key:
            return PIPELINE, torch
        if PIPELINE is not None:
            PIPELINE = None
            PIPELINE_MODEL = None
            gc.collect()
            torch.cuda.empty_cache()

        config = MODEL_IDS[model_key]
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        if config["family"] == "wan":
            from diffusers import WanPipeline

            pipeline = WanPipeline.from_pretrained(config["repo"], torch_dtype=dtype)
        else:
            from diffusers import CogVideoXPipeline

            pipeline = CogVideoXPipeline.from_pretrained(config["repo"], torch_dtype=dtype)
        if config["offload"] == "sequential":
            pipeline.enable_sequential_cpu_offload()
        else:
            pipeline.enable_model_cpu_offload()
        PIPELINE = pipeline
        PIPELINE_MODEL = model_key
        return pipeline, torch


def render_video(job_id: str, request: dict[str, str]) -> None:
    config = MODEL_IDS[request["model"]]
    width, height = dimensions_for(request["model"], request["format"])
    frames = int(config["frames"])
    fps = int(config["fps"])
    clip_seconds = (frames - 1) / fps
    total_clips = math.ceil(VIDEO_SECONDS / clip_seconds)
    work_dir = DATA_ROOT / f".render-{job_id}"
    output_path = VIDEO_ROOT / f"{job_id}.mp4"

    try:
        update_job(
            job_id,
            status="loading",
            total_clips=total_clips,
            message=f"Loading {config['label']}. The first run downloads its model weights.",
        )
        pipeline, torch = get_pipeline(request["model"])
        work_dir.mkdir(parents=True, exist_ok=False)

        for clip_index in range(total_clips):
            update_job(
                job_id,
                status="rendering",
                message=f"Rendering shot {clip_index + 1} of {total_clips} on your GPU.",
            )
            prompt = (
                f"{request['prompt']} "
                f"Visual style: {STYLE_PROMPTS[request['style']]}. "
                f"Shot {clip_index + 1} of a continuous film: keep the same subject, setting, "
                "color palette, and visual design, with a subtle continuation of the action."
            )
            generator = torch.Generator(device="cuda").manual_seed(random.randrange(0, 2**31))
            result = pipeline(
                prompt=prompt,
                height=height,
                width=width,
                num_frames=frames,
                num_inference_steps=int(config["steps"]),
                guidance_scale=float(config["guidance"]),
                generator=generator,
            )
            clip_path = work_dir / f"clip_{clip_index:03d}.mp4"
            from diffusers.utils import export_to_video

            export_to_video(result.frames[0], str(clip_path), fps=fps)
            del result, generator
            torch.cuda.empty_cache()
            update_job(
                job_id,
                completed_clips=clip_index + 1,
                progress=round((clip_index + 1) / total_clips * 95),
            )

        update_job(job_id, status="assembling", progress=98, message="Joining the shots into a five-minute MP4.")
        concat_path = work_dir / "clips.txt"
        concat_path.write_text(
            "".join(f"file 'clip_{index:03d}.mp4'\n" for index in range(total_clips)),
            encoding="utf-8",
        )
        import imageio_ffmpeg

        command = [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_path),
            "-t", str(VIDEO_SECONDS),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-an",
            "-movflags", "+faststart",
            str(output_path),
        ]
        completed = subprocess.run(command, cwd=work_dir, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"Couldn't assemble video: {completed.stderr[-1200:]}")
        update_job(
            job_id,
            status="complete",
            progress=100,
            completed_clips=total_clips,
            message="Your five-minute video is ready.",
            video_url=f"/api/video/jobs/{job_id}/video",
        )
    except Exception as error:
        logging.exception("Video generation failed for job %s", job_id)
        output_path.unlink(missing_ok=True)
        update_job(job_id, status="failed", message=str(error)[:1200] or "Video generation failed.")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


class FrostwaveHandler(BaseHTTPRequestHandler):
    server_version = "FrostwaveLocal/1.0"

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_asset(self, filename: str, content_type: str) -> None:
        path = ROOT / filename
        if not path.is_file():
            self.send_json(404, {"error": f"Missing app file: {filename}"})
            return
        content = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self.serve_asset("index.html", "text/html; charset=utf-8")
        elif path == "/app.js":
            self.serve_asset("app.js", "text/javascript; charset=utf-8")
        elif path == "/styles.css":
            self.serve_asset("styles.css", "text/css; charset=utf-8")
        elif path == "/api/video/health":
            status = runtime_status()
            with JOBS_LOCK:
                status["queued_jobs"] = sum(job["status"] in {"queued", "loading", "rendering", "assembling"} for job in JOBS.values())
            self.send_json(200, status)
        else:
            match = re.fullmatch(r"/api/video/jobs/([0-9a-f-]{36})(?:/(video))?", path)
            if not match:
                self.send_json(404, {"error": "Not found."})
                return
            job_id, video_route = match.groups()
            try:
                uuid.UUID(job_id)
            except ValueError:
                self.send_json(404, {"error": "Not found."})
                return
            with JOBS_LOCK:
                job = dict(JOBS.get(job_id, {}))
            if not job:
                self.send_json(404, {"error": "Video job not found. Jobs are held while the local engine is running."})
                return
            if video_route:
                output_path = VIDEO_ROOT / f"{job_id}.mp4"
                if job["status"] != "complete" or not output_path.is_file():
                    self.send_json(404, {"error": "This video isn't ready yet."})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(output_path.stat().st_size))
                self.send_header("Cache-Control", "private, max-age=3600")
                self.end_headers()
                with output_path.open("rb") as video_file:
                    shutil.copyfileobj(video_file, self.wfile)
                return
            self.send_json(200, job)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/video/jobs":
            self.send_json(404, {"error": "Not found."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid Content-Length."})
            return
        if content_length <= 0 or content_length > 4096:
            self.send_json(413, {"error": "Request must contain a short JSON video prompt."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
            request = validate_request(payload)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
            return

        runtime = runtime_status()
        if not runtime["ready"]:
            self.send_json(503, {"error": runtime["message"]})
            return
        job_id = str(uuid.uuid4())
        config = MODEL_IDS[request["model"]]
        total_clips = math.ceil(VIDEO_SECONDS / ((int(config["frames"]) - 1) / int(config["fps"])))
        job = {
            "id": job_id,
            "model": config["label"],
            "status": "queued",
            "progress": 0,
            "completed_clips": 0,
            "total_clips": total_clips,
            "message": "Waiting for the local GPU.",
            "video_url": None,
        }
        with JOBS_LOCK:
            JOBS[job_id] = job
        try:
            WORKERS.submit(render_video, job_id, request)
        except RuntimeError as error:
            with JOBS_LOCK:
                JOBS.pop(job_id, None)
            self.send_json(503, {"error": f"Couldn't queue the video: {error}"})
            return
        self.send_json(202, job)


def main() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    VIDEO_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("FROSTWAVE_PORT", "8000"))), FrostwaveHandler)
    logging.info("Frostwave local app: http://127.0.0.1:%s", server.server_address[1])
    logging.info("Generated videos will be saved in %s", VIDEO_ROOT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Stopping Frostwave local app.")
    finally:
        server.server_close()
        WORKERS.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    main()
