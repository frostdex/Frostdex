from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


DATA_ROOT = Path(os.environ.get("FROSTWAVE_DATA_DIR", Path.home() / ".frostwave"))
DATABASE_PATH = DATA_ROOT / "frostwave.sqlite3"
_INIT_LOCK = threading.Lock()
_INITIALIZED = False


def connect() -> sqlite3.Connection:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    with _INIT_LOCK:
        if _INITIALIZED:
            return
        with database() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS auth_nonces (
                    nonce TEXT PRIMARY KEY,
                    address TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    message TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    address TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
                CREATE TABLE IF NOT EXISTS media_tickets (
                    token_hash TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    address TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES video_jobs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS media_tickets_expiry ON media_tickets(expires_at);
                CREATE TABLE IF NOT EXISTS video_jobs (
                    id TEXT PRIMARY KEY,
                    address TEXT NOT NULL,
                    model TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    completed_clips INTEGER NOT NULL DEFAULT 0,
                    total_clips INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS video_jobs_owner ON video_jobs(address, created_at);
                CREATE TABLE IF NOT EXISTS music_jobs (
                    id TEXT PRIMARY KEY,
                    address TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL,
                    is_public INTEGER NOT NULL DEFAULT 0,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS music_jobs_owner ON music_jobs(address, created_at);
                CREATE INDEX IF NOT EXISTS music_jobs_discover ON music_jobs(is_public, status, created_at);
                CREATE TABLE IF NOT EXISTS audio_tickets (
                    token_hash TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    address TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES music_jobs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS audio_tickets_expiry ON audio_tickets(expires_at);
                """
            )
        _INITIALIZED = True


def create_nonce(nonce: str, address: str, origin: str, message: str, expires_at: int) -> None:
    initialize()
    with database() as connection:
        connection.execute("DELETE FROM auth_nonces WHERE expires_at<=?", (int(time.time()),))
        connection.execute(
            "INSERT INTO auth_nonces (nonce, address, origin, message, expires_at) VALUES (?, ?, ?, ?, ?)",
            (nonce, address.lower(), origin, message, expires_at),
        )


def consume_nonce(nonce: str, address: str, origin: str, now: int) -> str | None:
    initialize()
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT message, expires_at FROM auth_nonces WHERE nonce=? AND address=? AND origin=?",
            (nonce, address.lower(), origin),
        ).fetchone()
        connection.execute("DELETE FROM auth_nonces WHERE nonce=?", (nonce,))
        if row is None or int(row["expires_at"]) < now:
            return None
        return str(row["message"])


def create_session(token_hash: str, address: str, created_at: int, expires_at: int) -> None:
    initialize()
    with database() as connection:
        connection.execute("DELETE FROM auth_sessions WHERE expires_at<=?", (created_at,))
        connection.execute(
            "INSERT INTO auth_sessions (token_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash, address.lower(), created_at, expires_at),
        )


def get_session_address(token_hash: str, now: int) -> str | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            "SELECT address FROM auth_sessions WHERE token_hash=? AND expires_at>?",
            (token_hash, now),
        ).fetchone()
        return str(row["address"]) if row else None


def revoke_session(token_hash: str) -> None:
    initialize()
    with database() as connection:
        connection.execute("DELETE FROM auth_sessions WHERE token_hash=?", (token_hash,))


def create_job(job: dict[str, Any]) -> None:
    initialize()
    now = int(job["created_at"])
    with database() as connection:
        connection.execute(
            """
            INSERT INTO video_jobs (
                id, address, model, request_json, status, progress,
                completed_clips, total_clips, message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job["id"],
                job["address"].lower(),
                job["model"],
                json.dumps(job["request"]),
                job["status"],
                job["progress"],
                job["completed_clips"],
                job["total_clips"],
                job["message"],
                now,
                now,
            ),
        )


def update_job(job_id: str, **updates: Any) -> None:
    initialize()
    allowed = {
        "status",
        "progress",
        "completed_clips",
        "total_clips",
        "message",
    }
    values = {key: value for key, value in updates.items() if key in allowed}
    if not values:
        return
    assignments = ", ".join(f"{key}=?" for key in values)
    with database() as connection:
        connection.execute(
            f"UPDATE video_jobs SET {assignments}, updated_at=? WHERE id=?",
            (*values.values(), int(time.time()), job_id),
        )


def get_job(job_id: str, address: str) -> dict[str, Any] | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            """
            SELECT id, address, model, request_json, status, progress,
                   completed_clips, total_clips, message, created_at, updated_at
            FROM video_jobs WHERE id=? AND address=?
            """,
            (job_id, address.lower()),
        ).fetchone()
    return job_from_row(row) if row else None


def list_jobs(address: str) -> list[dict[str, Any]]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            """
            SELECT id, address, model, request_json, status, progress,
                   completed_clips, total_clips, message, created_at, updated_at
            FROM video_jobs WHERE address=? ORDER BY created_at DESC
            """,
            (address.lower(),),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def count_active_jobs() -> int:
    initialize()
    with database() as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS count FROM video_jobs WHERE status IN ('queued', 'loading', 'rendering', 'assembling')"
        ).fetchone()
    return int(row["count"])


def delete_jobs_before(cutoff: int) -> list[str]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            "SELECT id FROM video_jobs WHERE created_at<? AND status IN ('complete', 'failed')",
            (cutoff,),
        ).fetchall()
        ids = [str(row["id"]) for row in rows]
        connection.executemany("DELETE FROM video_jobs WHERE id=?", ((job_id,) for job_id in ids))
        connection.execute("DELETE FROM media_tickets WHERE expires_at<=?", (int(time.time()),))
    return ids


def create_media_ticket(token_hash: str, job_id: str, address: str, expires_at: int) -> None:
    initialize()
    with database() as connection:
        connection.execute("DELETE FROM media_tickets WHERE expires_at<=?", (int(time.time()),))
        connection.execute(
            "INSERT INTO media_tickets (token_hash, job_id, address, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash, job_id, address.lower(), expires_at),
        )


def get_media_ticket_address(token_hash: str, job_id: str, now: int) -> str | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            "SELECT address FROM media_tickets WHERE token_hash=? AND job_id=? AND expires_at>?",
            (token_hash, job_id, now),
        ).fetchone()
    return str(row["address"]) if row else None


def create_music_job(job: dict[str, Any]) -> None:
    initialize()
    now = int(job["created_at"])
    with database() as connection:
        connection.execute(
            """
            INSERT INTO music_jobs (
                id, address, request_json, status, message, is_public, is_favorite, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                job["id"],
                job["address"].lower(),
                json.dumps(job["request"]),
                job["status"],
                job["message"],
                int(job["is_public"]),
                now,
                now,
            ),
        )


def update_music_job(job_id: str, **updates: Any) -> None:
    initialize()
    allowed = {"status", "message"}
    values = {key: value for key, value in updates.items() if key in allowed}
    if not values:
        return
    assignments = ", ".join(f"{key}=?" for key in values)
    with database() as connection:
        connection.execute(
            f"UPDATE music_jobs SET {assignments}, updated_at=? WHERE id=?",
            (*values.values(), int(time.time()), job_id),
        )


def get_music_job(job_id: str, address: str) -> dict[str, Any] | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            """
            SELECT id, address, request_json, status, message, is_public,
                   is_favorite, created_at, updated_at
            FROM music_jobs WHERE id=? AND address=?
            """,
            (job_id, address.lower()),
        ).fetchone()
    return music_job_from_row(row) if row else None


def get_public_music_job(job_id: str) -> dict[str, Any] | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            """
            SELECT id, address, request_json, status, message, is_public,
                   is_favorite, created_at, updated_at
            FROM music_jobs WHERE id=? AND is_public=1 AND status='complete'
            """,
            (job_id,),
        ).fetchone()
    return music_job_from_row(row) if row else None


def list_music_jobs(address: str) -> list[dict[str, Any]]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            """
            SELECT id, address, request_json, status, message, is_public,
                   is_favorite, created_at, updated_at
            FROM music_jobs WHERE address=? ORDER BY created_at DESC
            """,
            (address.lower(),),
        ).fetchall()
    return [music_job_from_row(row) for row in rows]


def list_public_music_jobs() -> list[dict[str, Any]]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            """
            SELECT id, address, request_json, status, message, is_public,
                   is_favorite, created_at, updated_at
            FROM music_jobs WHERE is_public=1 AND status='complete' ORDER BY created_at DESC
            """
        ).fetchall()
    return [music_job_from_row(row) for row in rows]


def delete_music_jobs_before(cutoff: int) -> list[str]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            "SELECT id FROM music_jobs WHERE created_at<? AND status IN ('complete', 'failed')",
            (cutoff,),
        ).fetchall()
        ids = [str(row["id"]) for row in rows]
        connection.executemany("DELETE FROM music_jobs WHERE id=?", ((job_id,) for job_id in ids))
        connection.execute("DELETE FROM audio_tickets WHERE expires_at<=?", (int(time.time()),))
    return ids


def toggle_music_favorite(job_id: str, address: str) -> dict[str, Any] | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            "SELECT is_favorite FROM music_jobs WHERE id=? AND address=?",
            (job_id, address.lower()),
        ).fetchone()
        if row is None:
            return None
        favorite = 0 if row["is_favorite"] else 1
        connection.execute(
            "UPDATE music_jobs SET is_favorite=?, updated_at=? WHERE id=?",
            (favorite, int(time.time()), job_id),
        )
    return get_music_job(job_id, address)


def create_audio_ticket(token_hash: str, job_id: str, address: str, expires_at: int) -> None:
    initialize()
    with database() as connection:
        connection.execute("DELETE FROM audio_tickets WHERE expires_at<=?", (int(time.time()),))
        connection.execute(
            "INSERT INTO audio_tickets (token_hash, job_id, address, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash, job_id, address.lower(), expires_at),
        )


def get_audio_ticket_address(token_hash: str, job_id: str, now: int) -> str | None:
    initialize()
    with database() as connection:
        row = connection.execute(
            "SELECT address FROM audio_tickets WHERE token_hash=? AND job_id=? AND expires_at>?",
            (token_hash, job_id, now),
        ).fetchone()
    return str(row["address"]) if row else None


def interrupted_music_jobs() -> list[dict[str, Any]]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            """
            SELECT id, address, request_json, status, message, is_public,
                   is_favorite, created_at, updated_at
            FROM music_jobs WHERE status IN ('queued', 'loading', 'rendering')
            """
        ).fetchall()
    return [music_job_from_row(row) for row in rows]


def fail_interrupted_music_jobs(message: str) -> list[dict[str, Any]]:
    jobs = interrupted_music_jobs()
    for job in jobs:
        update_music_job(job["id"], status="failed", message=message)
    return jobs


def music_job_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "address": str(row["address"]),
        "request": json.loads(row["request_json"]),
        "status": str(row["status"]),
        "message": str(row["message"]),
        "is_public": bool(row["is_public"]),
        "favorite": bool(row["is_favorite"]),
        "created_at": int(row["created_at"]),
        "updated_at": int(row["updated_at"]),
    }


def public_music_job(job: dict[str, Any], include_prompt: bool = True) -> dict[str, Any]:
    request = job["request"]
    result = {
        "id": job["id"],
        "title": request["title"],
        "genre": request["genre"],
        "duration": request["duration"],
        "status": job["status"],
        "message": job["message"],
        "favorite": job["favorite"] if include_prompt else False,
        "is_public": job["is_public"],
        "created_at": job["created_at"],
        "artist": f"{job['address'][:6]}…{job['address'][-4:]}",
        "audio_url": f"/api/music/jobs/{job['id']}/audio" if job["status"] == "complete" else None,
    }
    if include_prompt:
        result["prompt"] = request["prompt"]
    return result


def interrupted_jobs() -> list[dict[str, Any]]:
    initialize()
    with database() as connection:
        rows = connection.execute(
            """
            SELECT id, address, model, request_json, status, progress,
                   completed_clips, total_clips, message, created_at, updated_at
            FROM video_jobs WHERE status IN ('queued', 'loading', 'rendering', 'assembling')
            """
        ).fetchall()
    return [job_from_row(row) for row in rows]


def fail_interrupted_jobs(message: str) -> list[dict[str, Any]]:
    jobs = interrupted_jobs()
    for job in jobs:
        update_job(job["id"], status="failed", message=message)
    return jobs


def job_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "address": str(row["address"]),
        "model": str(row["model"]),
        "request": json.loads(row["request_json"]),
        "status": str(row["status"]),
        "progress": int(row["progress"]),
        "completed_clips": int(row["completed_clips"]),
        "total_clips": int(row["total_clips"]),
        "message": str(row["message"]),
        "created_at": int(row["created_at"]),
        "updated_at": int(row["updated_at"]),
    }


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in job.items() if key not in {"address", "request"}}
    result["prompt"] = job["request"]["prompt"]
    result["video_url"] = f"/api/video/jobs/{job['id']}/video" if job["status"] == "complete" else None
    return result
