"use client";

import * as Tabs from "@radix-ui/react-tabs";
import {
  ArrowDownToLine,
  AudioLines,
  Check,
  Clock3,
  KeyRound,
  LoaderCircle,
  Music2,
  Settings2,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type StudioMode = "music" | "video";
type GenerationRecord = {
  id: string;
  mode: StudioMode;
  prompt: string;
  createdAt: number;
  status: "processing" | "done" | "failed";
  mediaUrl?: string;
  error?: string;
};

type JobStatus = {
  status: string;
  progress?: number;
  result_url?: string;
  error?: string;
};

const HISTORY_KEY = "frostwave-studio-history-v1";
const API_KEY_STORAGE = "frostwave-studio-deapi-key-v1";
const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12];

function readHistory(): GenerationRecord[] {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is GenerationRecord =>
      Boolean(
        record
        && typeof record.id === "string"
        && (record.mode === "music" || record.mode === "video")
        && typeof record.prompt === "string"
        && Number.isFinite(record.createdAt)
        && ["processing", "done", "failed"].includes(record.status),
      ),
    ).slice(0, 20);
  } catch {
    return [];
  }
}

function displayError(payload: unknown, fallback: string): string {
  if (
    payload
    && typeof payload === "object"
    && "error" in payload
    && typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

export default function StudioPage() {
  const [mode, setMode] = useState<StudioMode>("music");
  const [apiKey, setApiKey] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [musicDuration, setMusicDuration] = useState(60);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoDuration, setVideoDuration] = useState(6);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setApiKey(localStorage.getItem(API_KEY_STORAGE) || "");
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
    }
  }, [history]);

  useEffect(() => {
    if (!settingsOpen) return;
    setKeyDraft(apiKey);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, apiKey]);

  const updateRecord = useCallback((id: string, changes: Partial<GenerationRecord>) => {
    setHistory((previous) =>
      previous.map((record) => record.id === id ? { ...record, ...changes } : record),
    );
  }, []);

  const apiHeaders = useCallback((): HeadersInit => ({
    "Content-Type": "application/json",
    ...(apiKey ? { "x-deapi-api-key": apiKey } : {}),
  }), [apiKey]);

  async function pollJob(id: string, record: GenerationRecord) {
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000) {
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      const response = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, {
        headers: apiHeaders(),
        cache: "no-store",
      });
      const payload: JobStatus = await response.json().catch(() => ({} as JobStatus));
      if (!response.ok) {
        throw new Error(displayError(payload, `Status check failed (${response.status}).`));
      }
      if (typeof payload.status !== "string") {
        throw new Error("The provider returned an invalid job status.");
      }

      const status = payload.status.toLowerCase();
      if (status === "done" || status === "completed" || status === "complete") {
        if (!payload.result_url || !payload.result_url.startsWith("https://")) {
          throw new Error("The provider completed this job but did not return a valid media URL.");
        }
        updateRecord(id, { status: "done", mediaUrl: payload.result_url });
        setProgressText("Your generation is ready.");
        return;
      }
      if (status === "failed" || status === "error" || status === "cancelled") {
        const message = payload.error || "The provider could not complete this generation.";
        updateRecord(id, { status: "failed", error: message });
        throw new Error(message);
      }
      const progress = Number.isFinite(payload.progress) ? ` ${Math.round(payload.progress!)}%` : "";
      setProgressText(`${record.mode === "music" ? "Creating your track" : "Rendering your video"}${progress}…`);
    }
    throw new Error("This job is still running, but timed out in the studio. It may finish later; check your history again.");
  }

  async function startGeneration(currentMode: StudioMode) {
    const prompt = currentMode === "music" ? caption.trim() : videoPrompt.trim();
    if (!prompt) {
      setError(currentMode === "music" ? "Describe the sound you want first." : "Describe the video you want first.");
      return;
    }

    setBusy(true);
    setError("");
    setProgressText("Sending your request…");
    const body = currentMode === "music"
      ? { caption: prompt, lyrics, duration: musicDuration }
      : { prompt, duration: videoDuration, aspectRatio };

    try {
      const response = await fetch(`/api/${currentMode}`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
      const payload: { request_id?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(displayError(payload, `Generation request failed (${response.status}).`));
      }
      if (!payload.request_id) {
        throw new Error("The provider accepted no trackable generation job.");
      }

      const record: GenerationRecord = {
        id: payload.request_id,
        mode: currentMode,
        prompt,
        createdAt: Date.now(),
        status: "processing",
      };
      setHistory((previous) => [record, ...previous.filter((item) => item.id !== record.id)].slice(0, 20));
      await pollJob(record.id, record);
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : "Generation failed.";
      setError(message);
      setProgressText("");
    } finally {
      setBusy(false);
    }
  }

  function saveSettings() {
    const trimmed = keyDraft.trim();
    if (trimmed) localStorage.setItem(API_KEY_STORAGE, trimmed);
    else localStorage.removeItem(API_KEY_STORAGE);
    setApiKey(trimmed);
    setSettingsOpen(false);
  }

  return (
    <main className="min-h-screen px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between gap-4">
          <a href="#" className="flex items-center gap-3 text-lg font-bold tracking-tight">
            <span className="grid size-10 place-items-center rounded-2xl bg-ink text-lime">
              <AudioLines size={21} />
            </span>
            frostwave <span className="font-normal text-muted">studio</span>
          </a>
          <Button variant="secondary" size="small" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} /> Settings
          </Button>
        </header>

        <section className="mb-9 mt-12 max-w-3xl sm:mt-16">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em] text-[#62744d]">
            <Sparkles size={16} /> Your imagination, in motion
          </p>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.05em] sm:text-6xl">
            Make a little <span className="text-[#68824f]">magic.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted sm:text-lg">
            Turn a feeling into a song, or a few words into a moving scene. Start with a prompt and shape what comes next.
          </p>
        </section>

        <Tabs.Root value={mode} onValueChange={(value) => setMode(value as StudioMode)}>
          <Tabs.List aria-label="Generation type" className="mb-5 inline-flex rounded-full border border-black/5 bg-white/70 p-1.5 shadow-sm">
            <Tabs.Trigger
              value="music"
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-muted transition data-[state=active]:bg-ink data-[state=active]:text-white"
            >
              <Music2 size={17} /> Generate music
            </Tabs.Trigger>
            <Tabs.Trigger
              value="video"
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-muted transition data-[state=active]:bg-ink data-[state=active]:text-white"
            >
              <Video size={17} /> Generate video
            </Tabs.Trigger>
          </Tabs.List>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
            <section className="rounded-[2rem] border border-black/5 bg-white p-5 shadow-card sm:p-8">
              <Tabs.Content value="music" className="space-y-6 focus:outline-none">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="caption" className="text-sm font-bold">Describe your sound</label>
                    <span className="text-xs text-muted">{caption.length}/1000</span>
                  </div>
                  <textarea
                    id="caption"
                    value={caption}
                    onChange={(event) => setCaption(event.target.value)}
                    maxLength={1000}
                    rows={4}
                    placeholder="Warm indie folk, brushed drums, soft piano, hopeful and nostalgic..."
                    className="w-full resize-y rounded-2xl border border-black/10 bg-[#fafaf7] p-4 leading-6 placeholder:text-[#a0a39c]"
                  />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="lyrics" className="text-sm font-bold">Lyrics</label>
                    <span className="text-xs text-muted">Optional · section markers welcome</span>
                  </div>
                  <textarea
                    id="lyrics"
                    value={lyrics}
                    onChange={(event) => setLyrics(event.target.value)}
                    maxLength={5000}
                    rows={5}
                    placeholder={"[Verse]\nThe streetlights blur into gold...\n\n[Chorus]\nWe are going home tonight..."}
                    className="w-full resize-y rounded-2xl border border-black/10 bg-[#fafaf7] p-4 font-mono text-sm leading-6 placeholder:font-sans placeholder:text-[#a0a39c]"
                  />
                </div>
                <label className="block">
                  <span className="mb-3 flex items-center justify-between text-sm font-bold">
                    Song length <span className="font-medium text-muted">{musicDuration}s</span>
                  </span>
                  <input
                    type="range"
                    min={30}
                    max={300}
                    step={10}
                    value={musicDuration}
                    onChange={(event) => setMusicDuration(Number(event.target.value))}
                    className="w-full accent-[#73934d]"
                  />
                  <span className="mt-1 flex justify-between text-xs text-muted"><span>30 sec</span><span>5 min</span></span>
                </label>
                <Button className="w-full" disabled={busy} onClick={() => startGeneration("music")}>
                  {busy ? <LoaderCircle className="animate-spin" size={18} /> : <Music2 size={18} />}
                  {busy ? "Creating your song…" : "Create music"}
                </Button>
              </Tabs.Content>

              <Tabs.Content value="video" className="space-y-6 focus:outline-none">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="video-prompt" className="text-sm font-bold">Describe your video</label>
                    <span className="text-xs text-muted">{videoPrompt.length}/1000</span>
                  </div>
                  <textarea
                    id="video-prompt"
                    value={videoPrompt}
                    onChange={(event) => setVideoPrompt(event.target.value)}
                    maxLength={1000}
                    rows={7}
                    placeholder="A small sailboat gliding through a misty fjord at sunrise, slow cinematic camera..."
                    className="w-full resize-y rounded-2xl border border-black/10 bg-[#fafaf7] p-4 leading-6 placeholder:text-[#a0a39c]"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    <span className="mb-2 block text-sm font-bold">Duration</span>
                    <select
                      value={videoDuration}
                      onChange={(event) => setVideoDuration(Number(event.target.value))}
                      className="min-h-12 w-full rounded-xl border border-black/10 bg-[#fafaf7] px-3"
                    >
                      {VIDEO_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} seconds</option>)}
                    </select>
                  </label>
                  <label>
                    <span className="mb-2 block text-sm font-bold">Aspect ratio</span>
                    <select
                      value={aspectRatio}
                      onChange={(event) => setAspectRatio(event.target.value as "16:9" | "9:16")}
                      className="min-h-12 w-full rounded-xl border border-black/10 bg-[#fafaf7] px-3"
                    >
                      <option value="16:9">16:9 · Landscape</option>
                      <option value="9:16">9:16 · Portrait</option>
                    </select>
                  </label>
                </div>
                <Button className="w-full" disabled={busy} onClick={() => startGeneration("video")}>
                  {busy ? <LoaderCircle className="animate-spin" size={18} /> : <Video size={18} />}
                  {busy ? "Rendering your video…" : "Create video"}
                </Button>
              </Tabs.Content>

              {error && (
                <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800">
                  {error}
                </p>
              )}
              {progressText && (
                <p role="status" className="flex items-center gap-2 text-sm text-[#526c3d]">
                  {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}
                  {progressText}
                </p>
              )}
            </section>

            <aside className="space-y-5">
              <section className="rounded-[2rem] bg-moss/70 p-6 sm:p-7">
                <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-white/80 text-[#49643a]">
                  <KeyRound size={20} />
                </div>
                <h2 className="text-lg font-bold">Connect your generation key</h2>
                <p className="mt-2 text-sm leading-6 text-[#586052]">
                  Add your deAPI key in Settings, or configure <code className="rounded bg-white/70 px-1">DEAPI_API_KEY</code> in Vercel.
                </p>
                <p className="mt-3 text-xs leading-5 text-[#586052]">
                  Generation uses provider credits. deAPI currently advertises a limited sign-up bonus for eligible new accounts; check your balance and set an API-key spending limit.
                </p>
                <Button variant="secondary" size="small" className="mt-5" onClick={() => setSettingsOpen(true)}>
                  <Settings2 size={15} /> Configure key
                </Button>
              </section>

              <section className="rounded-[2rem] border border-black/5 bg-white p-6 shadow-card">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Your creations</p>
                    <h2 className="mt-1 text-xl font-bold">Recent history</h2>
                  </div>
                  <Clock3 size={19} className="text-muted" />
                </div>
                {history.length === 0 ? (
                  <p className="rounded-2xl bg-[#fafaf7] p-4 text-sm leading-6 text-muted">
                    Your completed tracks and clips will appear here. History is saved only in this browser.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {history.slice(0, 6).map((record) => (
                      <li key={record.id} className="rounded-2xl bg-[#fafaf7] p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide text-[#687260]">
                            {record.mode === "music" ? <Music2 size={14} /> : <Video size={14} />}
                            {record.mode}
                          </span>
                          <span className="shrink-0 text-xs text-muted">
                            {record.status === "processing" ? "Processing" : record.status === "done" ? "Ready" : "Failed"}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-sm leading-5">{record.prompt}</p>
                        {record.status === "done" && record.mediaUrl && (
                          record.mode === "music"
                            ? <audio className="mt-3 w-full" controls src={record.mediaUrl} />
                            : <video className="mt-3 max-h-52 w-full rounded-xl bg-black" controls src={record.mediaUrl} />
                        )}
                        {record.status === "failed" && record.error && (
                          <p className="mt-2 text-xs leading-5 text-red-700">{record.error}</p>
                        )}
                        {record.status === "done" && record.mediaUrl && (
                          <a
                            href={record.mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            download
                            className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-[#55713e] hover:underline"
                          >
                            <ArrowDownToLine size={14} /> Open / download
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </Tabs.Root>

      </div>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="w-full max-w-md rounded-[2rem] bg-paper p-6 shadow-2xl sm:p-8"
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Studio settings</p>
                <h2 id="settings-title" className="mt-1 text-2xl font-bold">deAPI key</h2>
              </div>
              <Button variant="ghost" size="small" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                <X size={18} />
              </Button>
            </div>
            <label htmlFor="api-key" className="mb-2 block text-sm font-semibold">Your API key</label>
            <input
              id="api-key"
              type="password"
              autoComplete="new-password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="Paste a deAPI API key"
              className="min-h-12 w-full rounded-xl border border-black/10 bg-white px-4"
            />
            <p className="mt-3 text-xs leading-5 text-muted">
              Saved in this browser only. It is sent over HTTPS to this app’s API route and is never written to the site’s server configuration.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {apiKey && (
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    setKeyDraft("");
                    localStorage.removeItem(API_KEY_STORAGE);
                    setApiKey("");
                    setSettingsOpen(false);
                  }}
                >
                  Remove saved key
                </Button>
              )}
              <Button variant="secondary" size="small" onClick={() => setSettingsOpen(false)}>Cancel</Button>
              <Button size="small" onClick={saveSettings}><Check size={15} /> Save key</Button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
