# Frostwave

Frostwave is a static frontend plus a persistent Python backend. The frontend is prepared for Vercel; wallet-authenticated user data and media storage stay on the backend. Set `FAL_KEY` on the backend to use Fal.ai for hosted video and music generation without a local GPU. Fal video generation creates one short clip per request; without `FAL_KEY`, generation uses the local GPU models.

## Deploy the frontend to Vercel

1. Import this repository into Vercel.
2. Set the build environment variable `FROSTWAVE_API_URL` to the public HTTPS **origin** of the persistent Python backend, for example `https://gpu-api.example.com` (no path or trailing API route).
3. Set `FROSTWAVE_WALLETCONNECT_PROJECT_ID` to the public project ID from [Reown Cloud](https://cloud.reown.com/). Optionally set `FROSTWAVE_WALLETCONNECT_CHAINS` to a comma-separated list of EVM chain IDs; it defaults to `1,10,137,8453,42161` (Ethereum, Optimism, Polygon, Base, and Arbitrum).
4. Deploy. The included `vercel.json` builds a static site into `dist`; `.vercelignore` excludes the Python backend and its optional GPU-only dependencies.
5. Copy the exact Vercel site origin (including `https://`) for the backend's `FROSTWAVE_ALLOWED_ORIGINS` setting. Add each production or preview origin explicitly.

`FROSTWAVE_API_URL` is public frontend configuration, not a secret. `FAL_KEY` is a secret and belongs only in the Python backend host's environment; do not expose it in Vercel's browser-facing build configuration.

If wallet sign-in ends with “Failed to fetch,” check that the deployed frontend was built with the live backend's `FROSTWAVE_API_URL`, and that the backend's `FROSTWAVE_ALLOWED_ORIGINS` contains the exact frontend origin (including `https://`, with no path). Redeploy the frontend after changing its build variable.

## Run the backend

Use a persistent Linux host with internet access and disk space for generated media. To use Fal.ai, set `FAL_KEY` in this host's environment. Requests to Fal.ai may consume account credits or incur charges; pricing and available credits depend on your Fal.ai account. Without `FAL_KEY`, install the optional GPU dependencies and use a supported NVIDIA GPU.

1. For local GPU generation, install a PyTorch build matching the host's CUDA setup using [the PyTorch selector](https://pytorch.org/get-started/locally/).
2. Install the backend requirements and launch it:

   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   # For local GPU generation instead of Fal.ai:
   # pip install -r requirements-gpu.txt
   cp .env.example .env
   # Set FAL_KEY and FROSTWAVE_ALLOWED_ORIGINS to your exact Vercel site origin.
   set -a && . ./.env && set +a
   python server.py
   ```

3. Put the backend behind HTTPS using a reverse proxy or a trusted TLS ingress. Allow request bodies up to 32 MB for reference-audio uploads. The server itself binds to loopback by default. `FROSTWAVE_BIND_HOST=0.0.0.0` enables access through the host's network interface; do not expose the plain HTTP port directly to the internet.
4. Keep `FROSTWAVE_DATA_DIR` on a persistent disk/volume. SQLite holds wallet sessions and job history there; MP4s and WAVs are saved under its `videos/` and `music/` directories. Back up this directory. Optionally set `FROSTWAVE_VIDEO_RETENTION_DAYS` to automatically remove completed/failed media at startup; its default `0` keeps media indefinitely.

For local development, leave the bind host unset, set allowed origins to `http://127.0.0.1:8000,http://localhost:8000`, and open `http://127.0.0.1:8000`.

## Wallet and generation behavior

- Sign-in uses WalletConnect with an EIP-4361-style one-time challenge signed by the wallet. The server verifies the signature, stores only a hash of the revocable session token, and scopes video and music jobs to the wallet address. No Google account, email, or on-chain transaction is required.
- When `FAL_KEY` is configured, the backend sends one short video request or a music request to Fal.ai. Fal.ai usage can consume account credits or be billed; Frostwave does not check or cap the account balance. The Fal.ai ACE-Step endpoint does not accept the app's optional reference-audio uploads.
- Without `FAL_KEY`, jobs use the local GPU models; five-minute videos are assembled from many short shots and trimmed to 300 seconds. The MP4 output is silent. Local music jobs use ACE-Step, and optional WAV, MP3, FLAC, or OGG reference clips guide audio-to-audio generation.
- Vercel deploys only the static website. It cannot run this persistent Python API or store its SQLite database/video files.

## Tests and build

```sh
node --check app.js
npm run build
python3 -m unittest discover -s tests
```
