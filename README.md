# Frostwave Studio

Frostwave Studio is a Next.js App Router application for generating music with ACE-Step through deAPI and text-to-video through a video model enabled for your deAPI account. Generation runs on deAPI, not on Vercel.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. In Codespaces, forward port 3000.

The app can use a key saved in the Settings dialog (stored in this browser's local storage) or the server-side `DEAPI_API_KEY` environment variable. The browser-stored key is sent to this app's API routes over HTTPS and is not saved by the server.

## Deploy on Vercel

1. Import this repository into Vercel and use the repository root as the project root. The Vercel project framework must be **Next.js**, the build command should be `npm run build`, and the output-directory override should be empty/default.
2. In **Project Settings → Environment Variables**, add:
   - `DEAPI_API_KEY` — optional shared server-side deAPI key. Create one in the deAPI dashboard and mark this variable sensitive.
   - `DEAPI_MUSIC_MODEL` — optional. Defaults to `AceStep_1_5_XL_Turbo_INT8`.
   - `DEAPI_VIDEO_MODEL` — optional model slug enabled for text-to-video on your deAPI account. If unset, the server selects an enabled model that supports the requested duration and format.
3. Redeploy after saving environment variables and updating the project build settings from the previous static-site configuration.

If `DEAPI_API_KEY` is configured, every visitor who can access the site can submit jobs using that account's credits. Before adding it, create a restricted API key with a spending limit in deAPI. Alternatively, leave it unset and let each person provide their own key in Settings.

deAPI uses paid inference credits. New eligible accounts may receive a limited sign-up bonus, but it is not guaranteed or unlimited. Check the current balance and pricing in your deAPI account. The application does not use Agnes or Hugging Face keys.

## Features

- Music prompt, optional section-marked lyrics, and 30–300 second duration.
- Text-to-video prompt, 4/5/6/8/10/12 second duration, and landscape or portrait ratio.
- Asynchronous job polling with audio/video players and download links.
- Recent generation history stored in this browser only.
- Local Settings dialog for a personal deAPI key.

Generated media URLs and provider job availability are controlled by deAPI and may expire. Clearing local browser data removes the saved history and personal API key.

## Environment variables

Copy `.env.example` to `.env.local` for local development. Do not commit `.env.local` or expose `DEAPI_API_KEY` through a `NEXT_PUBLIC_` variable.

## Checks

```sh
npm run typecheck
npm run build
```

## Provider documentation

- [deAPI quickstart and key setup](https://docs.deapi.ai/quickstart)
- [deAPI text-to-music API](https://docs.deapi.ai/api/v2/audio/music)
- [deAPI text-to-video API](https://docs.deapi.ai/api/v2/videos/generations)
- [deAPI job polling](https://docs.deapi.ai/api/v2/utilities/jobs)
