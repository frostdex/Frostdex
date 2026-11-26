# Frostwave

Frostwave deploys its static frontend and same-origin Node API functions to Vercel. The functions verify wallet signatures and submit video and music generation jobs to public Hugging Face ZeroGPU Spaces: Wan 2.2 for short videos and ACE-Step v1.5 for music. No separate Python API host or `FROSTWAVE_API_URL` is needed for this deployment.

## Deploy on Vercel

1. Import this GitHub repository into Vercel. The included build creates the static files in `dist`; functions under `api/` are deployed alongside them.
2. In Vercel **Project Settings → Environment Variables**, set:
   - `HF_TOKEN`: a Hugging Face token with read access. Mark it as a secret; never expose it in browser configuration.
   - `FROSTWAVE_WALLETCONNECT_PROJECT_ID`: your public project ID from [Reown Cloud](https://cloud.reown.com/), if it is not already set.
   - Optionally set `FROSTWAVE_HF_VIDEO_SPACE_URL` and `FROSTWAVE_HF_MUSIC_SPACE_URL` to different HTTPS Hugging Face Space origins. Defaults are the Wan 2.2 and ACE-Step Spaces listed below.
   - Optionally set `FROSTWAVE_ALLOWED_WALLETS` to comma-separated public wallet addresses. If unset, any connected EVM wallet can sign in. Remove an existing `FROSTWAVE_ALLOWED_WALLET` value from Vercel to allow all users; that older setting is still honored when present.
3. Redeploy after saving the variables. The API is same-origin at `https://wave-xi-ten.vercel.app/api/...`; do not set `FROSTWAVE_API_URL` or `FAL_KEY` for this Vercel integration.

The default public Spaces are [ACE-Step v1.5](https://huggingface.co/spaces/ACE-Step/Ace-Step-v1.5) and [Wan 2.2 text-to-video](https://huggingface.co/spaces/Upsampler/wan-2-2-14b-text-to-video). Hugging Face currently grants free accounts a limited daily ZeroGPU quota (5 GPU minutes per account per day); it is shared by all generations using that token and can run out. Queue availability and the public Spaces themselves are controlled by their owners and may change or become unavailable. One video request creates a single 3.5-second clip. Reference-audio uploads are not supported.

## What is and isn't stored

- Wallet jobs and favorites are stored in the current browser's local storage. They are not shared across browsers or devices; clearing browser data removes them.
- Discover sharing is disabled because this setup has no shared database.
- Wallet sessions are stateless and last one hour. Signing out clears the browser session but cannot revoke a copied token server-side. Sign-in challenges expire after five minutes; without a database they are not recorded as one-time-use.
- Generated media is served from the public Hugging Face Spaces and may be temporary. Follow their terms and retention behavior for generated files.

## Optional local Python engine

The original Python service remains available for local GPU generation. Install `requirements.txt`; for video or ACE-Step music generation, also install a CUDA-enabled PyTorch build and `requirements-gpu.txt`. Set `FROSTWAVE_BIND_HOST=127.0.0.1`, `FROSTWAVE_PORT=8000`, and run `python server.py`.

## Tests and build

```sh
node --check app.js
npm run build
npm run test:api
python3 -m unittest discover -s tests
```
