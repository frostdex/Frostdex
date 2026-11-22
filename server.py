from __future__ import annotations

import gc
import hashlib
import json
import logging
import math
import os
import random
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import auth
import music_engine
import storage


ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("FROSTWAVE_DATA_DIR", Path.home() / ".frostwave"))
VIDEO_ROOT = DATA_ROOT / "videos"
MUSIC_ROOT = DATA_ROOT / "music"
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
    storage.update_job(job_id, **updates)


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
        )
    except Exception as error:
        logging.exception("Video generation failed for job %s", job_id)
        output_path.unlink(missing_ok=True)
        update_job(job_id, status="failed", message=str(error)[:1200] or "Video generation failed.")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


class FrostwaveHandler(BaseHTTPRequestHandler):
    server_version = "FrostwaveLocal/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        request = self.requestline.split(" ", 2)
        if len(request) == 3:
            request[1] = urlparse(request[1]).path
        logging.info("%s - %s", self.address_string(), " ".join(request))

    def end_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin.rstrip("/") in auth.allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

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

    def read_json(self) -> Any:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length.") from error
        if content_length <= 0 or content_length > 16 * 1024:
            raise ValueError("Request must contain a short JSON body.")
        try:
            return json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Request body must be valid JSON.") from error

    def request_address(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin:
            try:
                auth.validate_origin(origin)
            except ValueError:
                self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
                return None
        address = auth.authenticate(self.headers.get("Authorization"))
        if address is None:
            self.send_json(401, {"error": "Connect your wallet to access this feature."})
        return address

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin")
        if not origin or origin.rstrip("/") not in auth.allowed_origins():
            self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        if path == "/":
            self.serve_asset("index.html", "text/html; charset=utf-8")
        elif path == "/app.js":
            self.serve_asset("app.js", "text/javascript; charset=utf-8")
        elif path == "/styles.css":
            self.serve_asset("styles.css", "text/css; charset=utf-8")
        elif path == "/config.js":
            self.serve_asset("config.js", "text/javascript; charset=utf-8")
        elif path == "/api/video/health":
            status = runtime_status()
            status["queued_jobs"] = storage.count_active_jobs()
            self.send_json(200, status)
        elif path == "/api/auth/me":
            address = self.request_address()
            if address is not None:
                self.send_json(200, {"address": address})
        elif path == "/api/video/jobs":
            address = self.request_address()
            if address is not None:
                self.send_json(200, {"jobs": [storage.public_job(job) for job in storage.list_jobs(address)]})
        elif path == "/api/music/jobs":
            address = self.request_address()
            if address is not None:
                self.send_json(200, {"jobs": [storage.public_music_job(job) for job in storage.list_music_jobs(address)]})
        elif path == "/api/discover":
            origin = self.headers.get("Origin")
            if origin:
                try:
                    auth.validate_origin(origin)
                except ValueError:
                    self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
                    return
            self.send_json(
                200,
                {"tracks": [storage.public_music_job(job, include_prompt=False) for job in storage.list_public_music_jobs()]},
            )
        else:
            audio_match = re.fullmatch(r"/api/music/jobs/([0-9a-f-]{36})(?:/(audio))?", path)
            if audio_match:
                job_id, audio_route = audio_match.groups()
                try:
                    uuid.UUID(job_id)
                except ValueError:
                    self.send_json(404, {"error": "Not found."})
                    return
                is_audio = bool(audio_route)
                if is_audio:
                    ticket = parse_qs(parsed_url.query).get("ticket", [""])[0]
                    address = storage.get_audio_ticket_address(
                        hashlib.sha256(ticket.encode()).hexdigest(),
                        job_id,
                        int(time.time()),
                    ) if ticket else self.request_address()
                    if ticket and address is None:
                        self.send_json(401, {"error": "This audio link expired. Open your library to get a new one."})
                        return
                    if ticket and self.headers.get("Origin"):
                        try:
                            auth.validate_origin(self.headers.get("Origin"))
                        except ValueError:
                            self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
                            return
                else:
                    address = self.request_address()
                if address is None:
                    return
                job = storage.get_music_job(job_id, address)
                if job is None and is_audio:
                    job = storage.get_public_music_job(job_id)
                if job is None:
                    self.send_json(404, {"error": "Song not found."})
                    return
                if is_audio:
                    output_path = MUSIC_ROOT / f"{job_id}.wav"
                    if job["status"] != "complete" or not output_path.is_file():
                        self.send_json(404, {"error": "This audio isn't ready yet."})
                        return
                    self.serve_media_file(output_path, "audio/wav", parsed_url)
                    return
                self.send_json(200, storage.public_music_job(job))
                return

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
            is_video = bool(video_route)
            if is_video:
                ticket = parse_qs(parsed_url.query).get("ticket", [""])[0]
                address = storage.get_media_ticket_address(
                    hashlib.sha256(ticket.encode()).hexdigest(),
                    job_id,
                    int(time.time()),
                ) if ticket else self.request_address()
                if ticket and address is None:
                    self.send_json(401, {"error": "This video link expired. Open your library to get a new one."})
                    return
                if ticket and self.headers.get("Origin"):
                    try:
                        auth.validate_origin(self.headers.get("Origin"))
                    except ValueError:
                        self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
                        return
            else:
                address = self.request_address()
            if address is None:
                return
            job = storage.get_job(job_id, address)
            if job is None:
                self.send_json(404, {"error": "Video job not found."})
                return
            if is_video:
                output_path = VIDEO_ROOT / f"{job_id}.mp4"
                if job["status"] != "complete" or not output_path.is_file():
                    self.send_json(404, {"error": "This video isn't ready yet."})
                    return
                self.serve_media_file(output_path, "video/mp4", parsed_url)
                return
            self.send_json(200, storage.public_job(job))

    def serve_media_file(self, output_path: Path, content_type: str, parsed_url: Any) -> None:
        file_size = output_path.stat().st_size
        start = 0
        end = file_size - 1
        status_code = 200
        range_header = self.headers.get("Range")
        if range_header:
            range_match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not range_match or (not range_match.group(1) and not range_match.group(2)):
                self.send_json(416, {"error": "Invalid media byte range."})
                return
            if range_match.group(1):
                start = int(range_match.group(1))
                if range_match.group(2):
                    end = int(range_match.group(2))
            else:
                suffix_length = int(range_match.group(2))
                start = max(file_size - suffix_length, 0)
            if start >= file_size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            end = min(end, file_size - 1)
            status_code = 206
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        query = parse_qs(parsed_url.query)
        if query.get("download") == ["1"]:
            filename = "frostwave-song.wav" if content_type == "audio/wav" else "frostwave-video.mp4"
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        if status_code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        with output_path.open("rb") as media_file:
            media_file.seek(start)
            shutil.copyfileobj(media_file, self.wfile)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        ticket_match = re.fullmatch(r"/api/video/jobs/([0-9a-f-]{36})/ticket", path)
        music_ticket_match = re.fullmatch(r"/api/music/jobs/([0-9a-f-]{36})/ticket", path)
        favorite_match = re.fullmatch(r"/api/music/jobs/([0-9a-f-]{36})/favorite", path)
        if (
            path not in {"/api/auth/nonce", "/api/auth/verify", "/api/auth/logout", "/api/video/jobs", "/api/music/jobs"}
            and not ticket_match
            and not music_ticket_match
            and not favorite_match
        ):
            self.send_json(404, {"error": "Not found."})
            return
        if path == "/api/auth/logout":
            auth.revoke(self.headers.get("Authorization"))
            self.send_json(200, {"signed_out": True})
            return
        if favorite_match:
            address = self.request_address()
            if address is None:
                return
            job = storage.toggle_music_favorite(favorite_match.group(1), address)
            if job is None:
                self.send_json(404, {"error": "Song not found."})
                return
            self.send_json(200, storage.public_music_job(job))
            return
        if music_ticket_match:
            job_id = music_ticket_match.group(1)
            origin = self.headers.get("Origin")
            if origin:
                try:
                    auth.validate_origin(origin)
                except ValueError:
                    self.send_json(403, {"error": "This website origin isn't allowed by the GPU backend."})
                    return
            address = auth.authenticate(self.headers.get("Authorization"))
            job = storage.get_music_job(job_id, address) if address else None
            if job is None:
                job = storage.get_public_music_job(job_id)
            if job is None or job["status"] != "complete":
                self.send_json(404, {"error": "Completed song not found."})
                return
            ticket = secrets.token_urlsafe(32)
            expires_at = int(time.time()) + 15 * 60
            storage.create_audio_ticket(hashlib.sha256(ticket.encode()).hexdigest(), job_id, job["address"], expires_at)
            self.send_json(200, {
                "audio_url": f"/api/music/jobs/{job_id}/audio?ticket={ticket}",
                "expires_in": 15 * 60,
            })
            return
        if ticket_match:
            address = self.request_address()
            if address is None:
                return
            job_id = ticket_match.group(1)
            job = storage.get_job(job_id, address)
            if job is None or job["status"] != "complete":
                self.send_json(404, {"error": "Completed video not found."})
                return
            ticket = secrets.token_urlsafe(32)
            expires_at = int(time.time()) + 15 * 60
            storage.create_media_ticket(
                hashlib.sha256(ticket.encode()).hexdigest(),
                job_id,
                address,
                expires_at,
            )
            self.send_json(200, {
                "video_url": f"/api/video/jobs/{job_id}/video?ticket={ticket}",
                "expires_in": 15 * 60,
            })
            return

        try:
            payload = self.read_json()
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return

        if path in {"/api/auth/nonce", "/api/auth/verify"}:
            try:
                origin = auth.validate_origin(self.headers.get("Origin"))
                if not isinstance(payload, dict):
                    raise ValueError("Request body must be a JSON object.")
                address = payload.get("address")
                if not isinstance(address, str):
                    raise ValueError("Connect a valid EVM wallet address.")
                if path == "/api/auth/nonce":
                    chain_id = payload.get("chain_id")
                    if isinstance(chain_id, bool) or not isinstance(chain_id, int):
                        raise ValueError("The connected wallet returned an invalid chain ID.")
                    self.send_json(200, auth.create_challenge(origin, address, chain_id))
                    return
                nonce = payload.get("nonce")
                signature = payload.get("signature")
                if not isinstance(nonce, str) or not isinstance(signature, str):
                    raise ValueError("Wallet signature is missing.")
                token, signer = auth.verify_signature(origin, address, nonce, signature)
                self.send_json(200, {
                    "token": token,
                    "address": signer,
                    "expires_in": auth.SESSION_TTL_SECONDS,
                })
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            return

        address = self.request_address()
        if address is None:
            return
        if path == "/api/music/jobs":
            try:
                request = music_engine.validate_request(payload)
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            runtime = runtime_status()
            if not runtime["ready"]:
                self.send_json(503, {"error": runtime["message"]})
                return
            job_id = str(uuid.uuid4())
            job = {
                "id": job_id,
                "address": address,
                "request": request,
                "status": "queued",
                "message": "Waiting for the local GPU.",
                "is_public": request["is_public"],
                "created_at": int(time.time()),
            }
            try:
                storage.create_music_job(job)
                WORKERS.submit(music_engine.render_music, job_id, request)
            except (RuntimeError, OSError, sqlite3.Error) as error:
                logging.exception("Couldn't queue music job %s", job_id)
                storage.update_music_job(job_id, status="failed", message="Couldn't queue this song on the local engine.")
                self.send_json(503, {"error": f"Couldn't queue the song: {error}"})
                return
            self.send_json(202, storage.public_music_job(job))
            return
        try:
            request = validate_request(payload)
        except ValueError as error:
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
            "address": address,
            "model": config["label"],
            "request": request,
            "status": "queued",
            "progress": 0,
            "completed_clips": 0,
            "total_clips": total_clips,
            "message": "Waiting for the local GPU.",
            "created_at": int(time.time()),
        }
        try:
            storage.create_job(job)
            WORKERS.submit(render_video, job_id, request)
        except (RuntimeError, OSError, sqlite3.Error) as error:
            logging.exception("Couldn't queue video job %s", job_id)
            storage.update_job(job_id, status="failed", message="Couldn't queue this video on the local engine.")
            self.send_json(503, {"error": f"Couldn't queue the video: {error}"})
            return
        self.send_json(202, storage.public_job(job))


def main() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    VIDEO_ROOT.mkdir(parents=True, exist_ok=True)
    MUSIC_ROOT.mkdir(parents=True, exist_ok=True)
    storage.initialize()
    for temporary_dir in DATA_ROOT.glob(".render-*"):
        if temporary_dir.is_dir():
            shutil.rmtree(temporary_dir, ignore_errors=True)
    interrupted = storage.fail_interrupted_jobs("The local engine restarted before this video finished.")
    if interrupted:
        logging.warning("Marked %d interrupted video job(s) as failed.", len(interrupted))
    interrupted_music = storage.fail_interrupted_music_jobs("The local engine restarted before this song finished.")
    if interrupted_music:
        logging.warning("Marked %d interrupted music job(s) as failed.", len(interrupted_music))
    retention_days = int(os.environ.get("FROSTWAVE_VIDEO_RETENTION_DAYS", "0"))
    if retention_days > 0:
        expired_ids = storage.delete_jobs_before(int(time.time()) - retention_days * 24 * 60 * 60)
        for job_id in expired_ids:
            (VIDEO_ROOT / f"{job_id}.mp4").unlink(missing_ok=True)
        expired_music_ids = storage.delete_music_jobs_before(int(time.time()) - retention_days * 24 * 60 * 60)
        for job_id in expired_music_ids:
            (MUSIC_ROOT / f"{job_id}.wav").unlink(missing_ok=True)
        if expired_ids or expired_music_ids:
            logging.info("Removed %d expired video(s) and %d expired song(s).", len(expired_ids), len(expired_music_ids))
    server = ThreadingHTTPServer(
        (os.environ.get("FROSTWAVE_BIND_HOST", "127.0.0.1"), int(os.environ.get("FROSTWAVE_PORT", "8000"))),
        FrostwaveHandler,
    )
    logging.info("Frostwave local app: http://%s:%s", *server.server_address[:2])
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
