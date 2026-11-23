# Frostwave

Frostwave is a static frontend plus a self-hosted Python GPU backend. The frontend is prepared for Vercel; video and music generation, wallet-authenticated user data, and media storage stay on the GPU backend. Video generation offers Wan 2.1 (1.3B and 14B), Wan 2.2 (A14B), and CogVideoX (2B and 5B), and assembles generated shots into a five-minute MP4. Music generation uses the local ACE-Step model for songs up to four minutes.

## Deploy the frontend to Vercel

1. Import this repository into Vercel.
2. Set the build environment variable `FROSTWAVE_API_URL` to the public HTTPS **origin** of the GPU backend, for example `https://gpu-api.example.com` (no path or trailing API route).
3. Set `FROSTWAVE_WALLETCONNECT_PROJECT_ID` to the public project ID from [Reown Cloud](https://cloud.reown.com/). Optionally set `FROSTWAVE_WALLETCONNECT_CHAINS` to a comma-separated list of EVM chain IDs; it defaults to `1,10,137,8453,42161` (Ethereum, Optimism, Polygon, Base, and Arbitrum).
4. Deploy. The included `vercel.json` builds a static site into `dist`; `.vercelignore` excludes the Python backend and its GPU-only dependencies so Vercel does not try to build them or run the GPU worker.
5. Copy the exact Vercel site origin (including `https://`) for the backend's `FROSTWAVE_ALLOWED_ORIGINS` setting. Add each production or preview origin explicitly.

`FROSTWAVE_API_URL` is public frontend configuration, not a secret. Do not put private keys, GPU credentials, or wallet secrets in Vercel's browser-exposed environment.

If wallet sign-in ends with “Failed to fetch,” check that the deployed frontend was built with the live backend's `FROSTWAVE_API_URL`, and that the backend's `FROSTWAVE_ALLOWED_ORIGINS` contains the exact frontend origin (including `https://`, with no path). Redeploy the frontend after changing its build variable.

## Run the GPU backend

Use a persistent Linux host with a supported NVIDIA GPU, CUDA-enabled PyTorch, internet access for first model downloads, and disk space for generated media. Wan 2.1 1.3B needs about 8.2 GB of VRAM; CogVideoX 2B can use sequential CPU offload but will be slower. Larger models need substantially more VRAM. ACE-Step downloads its model weights on first use and needs additional GPU memory and storage.

1. Install a PyTorch build matching the host's CUDA setup using [the PyTorch selector](https://pytorch.org/get-started/locally/).
2. Install the backend requirements and launch it:

   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env
   # Set FROSTWAVE_ALLOWED_ORIGINS to your exact Vercel site origin.
   set -a && . ./.env && set +a
   python server.py
   ```

3. Put the backend behind HTTPS using a reverse proxy or a trusted TLS ingress. Allow request bodies up to 32 MB for reference-audio uploads. The server itself binds to loopback by default. `FROSTWAVE_BIND_HOST=0.0.0.0` enables access through the host's network interface; do not expose the plain HTTP port directly to the internet.
4. Keep `FROSTWAVE_DATA_DIR` on a persistent disk/volume. SQLite holds wallet sessions and job history there; MP4s and WAVs are saved under its `videos/` and `music/` directories. Back up this directory. Optionally set `FROSTWAVE_VIDEO_RETENTION_DAYS` to automatically remove completed/failed media at startup; its default `0` keeps media indefinitely.

For local development, leave the bind host unset, set allowed origins to `http://127.0.0.1:8000,http://localhost:8000`, and open `http://127.0.0.1:8000`.

## Wallet and generation behavior

- Sign-in uses WalletConnect with an EIP-4361-style one-time challenge signed by the wallet. The server verifies the signature, stores only a hash of the revocable session token, and scopes video and music jobs to the wallet address. No Google account, email, or on-chain transaction is required.
- There are no app-imposed generation-count quotas or paid API calls. Work is queued one-at-a-time on the GPU. Compute time, power, storage, and model licenses still apply.
- Five minutes of video is assembled from many short shots and trimmed to exactly 300 seconds. Independent shots may not maintain perfect continuity. Wan 2.1 1.3B is documented at roughly four minutes per five-second clip on an RTX 4090, so a five-minute video can take several hours.
- The MP4 output is silent. Music jobs are generated locally by ACE-Step; songs appear in the private library by default, and only songs explicitly shared by their creator appear in Discover. The first generation downloads the ACE-Step model weights. Optional WAV, MP3, FLAC, or OGG reference clips (1 second to 4 minutes, up to 32 MB) guide audio-to-audio generation; they remain private and are removed after the job finishes.
- Vercel deploys only the static website. It cannot run this long-lived GPU worker or persist its SQLite database/video files.

## Tests and build

```sh
node --check app.js
npm run build
python3 -m unittest discover -s tests
```
