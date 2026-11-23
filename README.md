# Frostwave

Frostwave deploys its static frontend and same-origin Node API functions to Vercel. The Vercel functions verify wallet signatures and submit video and music generation requests to Fal.ai. No separate Python API host or `FROSTWAVE_API_URL` is needed for this deployment.

## Deploy on Vercel

1. Import this GitHub repository into Vercel. The included build creates the static files in `dist`; functions under `api/` are deployed alongside them.
2. In Vercel **Project Settings → Environment Variables**, set:
   - `FAL_KEY`: your Fal.ai API key. Keep it server-side; never add it as a `NEXT_PUBLIC_` or other browser-exposed variable.
   - `FROSTWAVE_ALLOWED_WALLET`: the public `0x...` address allowed to generate. This prevents other visitors from spending your Fal.ai balance.
   - `FROSTWAVE_WALLETCONNECT_PROJECT_ID`: your public project ID from [Reown Cloud](https://cloud.reown.com/), if it is not already set.
3. Redeploy after saving the variables. The API is same-origin at `https://wave-xi-ten.vercel.app/api/...`; do not set `FROSTWAVE_API_URL`.

Fal.ai charges/credits are controlled by your Fal.ai account. Vercel runs the Node functions, while Fal hosts the generated media. This integration uses one short five-second video clip per video request; Fal's ACE-Step endpoint does not support reference-audio uploads.

## What is and isn't stored

- Wallet jobs and favorites are stored in the current browser's local storage. They are not shared across browsers or devices; clearing browser data removes them.
- Discover sharing is disabled because this setup has no shared database.
- Wallet sessions are stateless and last one hour. Signing out clears the browser session but cannot revoke a copied token server-side. Sign-in challenges expire after five minutes; without a database they are not recorded as one-time-use.
- Generated media URLs are served by Fal.ai; follow Fal.ai's terms and retention behavior for generated files.

## Optional local Python engine

The original Python service remains available for local GPU generation. Install `requirements.txt`; for video or ACE-Step music generation, also install a CUDA-enabled PyTorch build and `requirements-gpu.txt`. Set `FROSTWAVE_BIND_HOST=127.0.0.1`, `FROSTWAVE_PORT=8000`, and run `python server.py`.

## Tests and build

```sh
node --check app.js
npm run build
npm run test:api
python3 -m unittest discover -s tests
```
