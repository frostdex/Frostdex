from __future__ import annotations

import hashlib
import os
import re
import secrets
import time
from urllib.parse import urlparse

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address

import storage


NONCE_TTL_SECONDS = 5 * 60
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
ADDRESS_PATTERN = re.compile(r"^0x[0-9a-fA-F]{40}$")


def allowed_origins() -> set[str]:
    configured = os.environ.get("FROSTWAVE_ALLOWED_ORIGINS", "")
    origins = {origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()}
    if not origins:
        origins = {"http://127.0.0.1:8000", "http://localhost:8000"}
    return origins


def validate_origin(origin: str | None) -> str:
    if not origin or origin == "null" or origin.rstrip("/") not in allowed_origins():
        raise ValueError("This website origin isn't allowed by the GPU backend.")
    normalized = origin.rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise ValueError("The website origin must be a valid HTTP(S) origin.")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("Public deployments must use HTTPS.")
    return normalized


def create_challenge(origin: str, address: str, chain_id: int) -> dict[str, str | int]:
    validate_origin(origin)
    if not ADDRESS_PATTERN.fullmatch(address):
        raise ValueError("Connect a valid EVM wallet address.")
    if isinstance(chain_id, bool) or not isinstance(chain_id, int) or chain_id < 1:
        raise ValueError("The connected wallet returned an invalid chain ID.")
    nonce = secrets.token_hex(16)
    now = int(time.time())
    domain = urlparse(origin).netloc
    checksum_address = to_checksum_address(address)
    message = (
        f"{domain} wants you to sign in with your Ethereum account:\n"
        f"{checksum_address}\n\n"
        "Sign in to Frostwave.\n\n"
        f"URI: {origin}/\n"
        "Version: 1\n"
        f"Chain ID: {chain_id}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))}\n"
        f"Expiration Time: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now + NONCE_TTL_SECONDS))}"
    )
    storage.create_nonce(nonce, address, origin, message, now + NONCE_TTL_SECONDS)
    return {"message": message, "nonce": nonce, "expires_in": NONCE_TTL_SECONDS}


def verify_signature(origin: str, address: str, nonce: str, signature: str) -> tuple[str, str]:
    validate_origin(origin)
    if not ADDRESS_PATTERN.fullmatch(address):
        raise ValueError("Connect a valid EVM wallet address.")
    if not re.fullmatch(r"[a-f0-9]{32}", nonce):
        raise ValueError("Invalid or expired wallet challenge.")
    if not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
        raise ValueError("The wallet returned an invalid signature.")
    message = storage.consume_nonce(nonce, address, origin, int(time.time()))
    if message is None:
        raise ValueError("Wallet challenge expired or already used. Please try again.")
    try:
        signer = Account.recover_message(encode_defunct(text=message), signature=signature)
    except Exception as error:
        raise ValueError("Couldn't verify the wallet signature.") from error
    if signer.lower() != address.lower():
        raise ValueError("The signature doesn't match the connected wallet.")
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    storage.create_session(hashlib.sha256(token.encode()).hexdigest(), address, now, now + SESSION_TTL_SECONDS)
    return token, signer


def authenticate(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:].strip()
    if len(token) < 32 or len(token) > 256:
        return None
    return storage.get_session_address(hashlib.sha256(token.encode()).hexdigest(), int(time.time()))


def revoke(authorization: str | None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        return
    token = authorization[7:].strip()
    if 32 <= len(token) <= 256:
        storage.revoke_session(hashlib.sha256(token.encode()).hexdigest())
