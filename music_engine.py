from __future__ import annotations

import hashlib
import logging
import math
import os
import random
import threading
import uuid
from pathlib import Path
from typing import Any

import storage


ROOT = Path(os.environ.get("FROSTWAVE_DATA_DIR", Path.home() / ".frostwave"))
MUSIC_ROOT = ROOT / "music"
CHECKPOINT_ROOT = ROOT / "models" / "ace-step"
AUDIO_REFERENCE_FORMATS = ("wav", "mp3", "flac", "ogg")
PIPELINE_LOCK = threading.Lock()
PIPELINE: Any = None


def audio_reference_directory(address: str) -> Path:
    owner_key = hashlib.sha256(address.lower().encode("utf-8")).hexdigest()
    return MUSIC_ROOT / "references" / owner_key


def find_audio_reference(address: str, reference_audio_id: str) -> Path | None:
    try:
        upload_id = str(uuid.UUID(reference_audio_id))
    except (AttributeError, TypeError, ValueError):
        return None
    directory = audio_reference_directory(address)
    for extension in AUDIO_REFERENCE_FORMATS:
        path = directory / f"{upload_id}.{extension}"
        if path.is_file():
            return path
    return None


def audio_reference_duration(path: Path) -> int:
    from mutagen import File as MutagenFile
    from mutagen import MutagenError

    try:
        audio_file = MutagenFile(str(path))
    except (MutagenError, OSError) as error:
        raise ValueError("This audio file couldn't be read.") from error
    if audio_file is None or audio_file.info is None:
        raise ValueError("This audio file couldn't be read.")
    duration = float(audio_file.info.length)
    if not math.isfinite(duration) or not 1 <= duration <= 240:
        raise ValueError("Reference audio must be between 1 second and 4 minutes.")
    return round(duration)


def validate_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 1000:
        raise ValueError("Add a music description of 1–1,000 characters.")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 80:
        raise ValueError("Add a title of 1–80 characters.")
    lyrics = payload.get("lyrics", "")
    if not isinstance(lyrics, str) or len(lyrics) > 4000:
        raise ValueError("Lyrics must be 4,000 characters or fewer.")
    genre = payload.get("genre")
    if not isinstance(genre, str) or not genre.strip() or len(genre) > 40:
        raise ValueError("Choose a supported music style.")
    duration = payload.get("duration")
    reference_audio_id = payload.get("reference_audio_id")
    if reference_audio_id is None:
        if isinstance(duration, bool) or not isinstance(duration, int) or duration not in {60, 120, 240}:
            raise ValueError("Choose a song length of 1, 2, or 4 minutes.")
    else:
        if not isinstance(reference_audio_id, str):
            raise ValueError("The uploaded reference audio is invalid.")
        try:
            reference_audio_id = str(uuid.UUID(reference_audio_id))
        except ValueError as error:
            raise ValueError("The uploaded reference audio is invalid.") from error
        if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 240:
            raise ValueError("Reference audio must be 1–240 seconds long.")
    vocal_style = payload.get("vocal_style")
    if vocal_style not in {"With vocals", "Instrumental"}:
        raise ValueError("Choose a vocal style.")
    if vocal_style == "Instrumental":
        lyrics = ""
    elif not lyrics.strip():
        raise ValueError("Add lyrics, or choose Instrumental.")
    is_public = payload.get("is_public", False)
    if not isinstance(is_public, bool):
        raise ValueError("Choose whether to share this song with Discover.")
    return {
        "prompt": prompt.strip(),
        "title": title.strip(),
        "lyrics": lyrics.strip(),
        "genre": genre.strip(),
        "duration": duration,
        "reference_audio_id": reference_audio_id,
        "vocal_style": vocal_style,
        "is_public": is_public,
    }


def get_pipeline() -> Any:
    global PIPELINE
    with PIPELINE_LOCK:
        if PIPELINE is not None:
            return PIPELINE
        import torch
        from acestep.pipeline_ace_step import ACEStepPipeline

        dtype = "bfloat16" if torch.cuda.is_bf16_supported() else "float32"
        CHECKPOINT_ROOT.mkdir(parents=True, exist_ok=True)
        PIPELINE = ACEStepPipeline(
            checkpoint_dir=str(CHECKPOINT_ROOT),
            dtype=dtype,
            cpu_offload=True,
        )
        return PIPELINE


def render_music(job_id: str, request: dict[str, Any], reference_audio_path: Path | None = None) -> None:
    output_path = MUSIC_ROOT / f"{job_id}.wav"
    try:
        storage.update_music_job(job_id, status="loading", message="Loading ACE-Step. Model weights download the first time.")
        pipeline = get_pipeline()
        MUSIC_ROOT.mkdir(parents=True, exist_ok=True)
        storage.update_music_job(job_id, status="rendering", message="Your local GPU is composing the song.")
        description = f"{request['genre']}, {request['prompt']}"
        if request["vocal_style"] == "Instrumental":
            description = f"Instrumental music, no vocals. {description}"
        seed = random.randrange(0, 2**31)
        pipeline(
            format="wav",
            audio_duration=request["duration"],
            prompt=description,
            lyrics=request["lyrics"],
            infer_step=60,
            guidance_scale=15.0,
            scheduler_type="euler",
            cfg_type="apg",
            omega_scale=10.0,
            manual_seeds=str(seed),
            guidance_interval=0.5,
            guidance_interval_decay=1.0,
            min_guidance_scale=3.0,
            use_erg_tag=True,
            use_erg_lyric=True,
            use_erg_diffusion=False,
            oss_steps="",
            guidance_scale_text=0.0,
            guidance_scale_lyric=0.0,
            audio2audio_enable=reference_audio_path is not None,
            ref_audio_strength=0.5,
            ref_audio_input=str(reference_audio_path) if reference_audio_path else None,
            save_path=str(output_path),
        )
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("ACE-Step completed without writing an audio file.")
        storage.update_music_job(job_id, status="complete", message="Your song is ready.")
    except Exception as error:
        logging.exception("Music generation failed for job %s", job_id)
        output_path.unlink(missing_ok=True)
        storage.update_music_job(job_id, status="failed", message=str(error)[:1000] or "Music generation failed.")
    finally:
        if reference_audio_path is not None:
            try:
                reference_audio_path.unlink(missing_ok=True)
            except OSError:
                logging.exception("Couldn't remove reference audio for job %s.", job_id)
