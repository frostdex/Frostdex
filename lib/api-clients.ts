import "server-only";

const DEAPI_BASE_URL = "https://api.deapi.ai";
const MUSIC_MODEL = process.env.DEAPI_MUSIC_MODEL || "AceStep_1_5_XL_Turbo_INT8";

export class DeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DeApiError";
  }
}

export interface MusicInput {
  caption: string;
  lyrics: string;
  duration: number;
}

export interface VideoInput {
  prompt: string;
  duration: number;
  aspectRatio: "16:9" | "9:16";
}

export interface DeApiJob {
  request_id: string;
}

export interface JobStatus {
  status: string;
  progress?: number;
  result_url?: string;
  error?: string;
  message?: string;
}

interface DeApiResponse<T> {
  data?: T;
  message?: string;
  errors?: unknown;
}

interface DeApiModel {
  slug: string;
  inference_types?: string[];
  info?: {
    defaults?: Record<string, unknown>;
    limits?: Record<string, unknown>;
    features?: Record<string, unknown>;
  };
}

function resolveApiKey(requestKey?: string | null): string {
  const key = requestKey?.trim() || process.env.DEAPI_API_KEY?.trim();
  if (!key) {
    throw new DeApiError(
      "Add a deAPI key in Settings or configure DEAPI_API_KEY in Vercel.",
      503,
    );
  }
  if (key.length > 512 || /[\r\n]/.test(key)) {
    throw new DeApiError("The deAPI key is invalid.", 400);
  }
  return key;
}

async function deapiRequest<T>(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${DEAPI_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...init.headers,
    },
    cache: "no-store",
    signal: init.signal || AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  let body: DeApiResponse<T> | null = null;
  try {
    body = JSON.parse(responseText) as DeApiResponse<T>;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = body?.message || responseText.slice(0, 500);
    throw new DeApiError(
      message || `deAPI returned HTTP ${response.status}.`,
      response.status,
    );
  }
  if (!body) {
    throw new DeApiError("deAPI returned an invalid response.", 502);
  }
  return body as T;
}

export async function createMusicJob(
  input: MusicInput,
  requestKey?: string | null,
): Promise<DeApiJob> {
  const apiKey = resolveApiKey(requestKey);
  const form = new FormData();
  form.set("model", MUSIC_MODEL);
  form.set("caption", input.caption);
  form.set("lyrics", input.lyrics.trim() || "[Instrumental]");
  form.set("duration", String(input.duration));
  form.set("inference_steps", "8");
  form.set("guidance_scale", "1");
  form.set("seed", "-1");
  form.set("format", "mp3");

  const response = await deapiRequest<{ data?: DeApiJob }>(
    "/api/v2/audio/music",
    apiKey,
    { method: "POST", body: form },
  );
  const requestId = response.data?.request_id;
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new DeApiError("deAPI did not return a valid music job ID.", 502);
  }
  return { request_id: requestId };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snapDimension(value: number, min: number, max: number, step: number): number {
  const firstAllowed = Math.ceil(min / step) * step;
  const lastAllowed = Math.floor(max / step) * step;
  if (lastAllowed < firstAllowed) return 0;
  return Math.min(lastAllowed, Math.max(firstAllowed, Math.round(value / step) * step));
}

async function getVideoModels(apiKey: string): Promise<DeApiModel[]> {
  const query = new URLSearchParams({
    limit: "50",
    "filter[inference_types]": "txt2video",
  });
  const response = await deapiRequest<{ data?: DeApiModel[] }>(
    `/api/v2/models?${query.toString()}`,
    apiKey,
  );
  const models = response.data?.filter((model) =>
    model.inference_types?.includes("txt2video"),
  ) || [];
  if (!models.length) {
    throw new DeApiError(
      "This deAPI account has no enabled text-to-video model.",
      422,
    );
  }
  return models;
}

function getVideoParameters(model: DeApiModel, input: VideoInput) {
  const defaults = model.info?.defaults || {};
  const limits = model.info?.limits || {};
  const features = model.info?.features || {};
  const fps = numberValue(defaults.fps)
    ?? (numberValue(limits.min_fps) === numberValue(limits.max_fps)
      ? numberValue(limits.min_fps)
      : undefined);
  if (!fps || fps < 1 || fps > 120) {
    throw new DeApiError(
      `The selected model (${model.slug}) does not publish a supported FPS default.`,
      502,
    );
  }

  const frames = input.duration * fps;
  const minFrames = numberValue(limits.min_frames) ?? 1;
  const maxFrames = numberValue(limits.max_frames) ?? 10_000;
  if (frames < minFrames || frames > maxFrames) {
    throw new DeApiError(
      `The selected model supports ${Math.ceil(minFrames / fps)}–${Math.floor(maxFrames / fps)} seconds at ${fps} FPS. Choose another duration or configure DEAPI_VIDEO_MODEL.`,
      422,
    );
  }

  const portrait = input.aspectRatio === "9:16";
  const desiredWidth = portrait ? 432 : 768;
  const desiredHeight = portrait ? 768 : 432;
  const step = numberValue(limits.dimension_multiple)
    ?? numberValue(limits.resolution_step)
    ?? 8;
  const minWidth = numberValue(limits.min_width) ?? step;
  const maxWidth = numberValue(limits.max_width) ?? Math.max(desiredWidth, 2048);
  const minHeight = numberValue(limits.min_height) ?? step;
  const maxHeight = numberValue(limits.max_height) ?? Math.max(desiredHeight, 2048);
  const maxPixels = numberValue(limits.max_pixels);
  const maxScale = Math.min(
    1,
    maxWidth / desiredWidth,
    maxHeight / desiredHeight,
    maxPixels ? Math.sqrt(maxPixels / (desiredWidth * desiredHeight)) : 1,
  );
  const minScale = Math.max(minWidth / desiredWidth, minHeight / desiredHeight);
  if (maxScale < minScale) {
    throw new DeApiError(
      `The selected model does not support the ${input.aspectRatio} aspect ratio at the available resolution.`,
      422,
    );
  }
  const width = snapDimension(desiredWidth * maxScale, minWidth, maxWidth, step);
  const height = snapDimension(desiredHeight * maxScale, minHeight, maxHeight, step);
  if (!width || !height || (maxPixels && width * height > maxPixels)) {
    throw new DeApiError(
      `The selected model does not support the ${input.aspectRatio} aspect ratio at the available resolution.`,
      422,
    );
  }

  const body: Record<string, string | number | boolean> = {
    prompt: input.prompt,
    model: model.slug,
    width,
    height,
    frames,
    fps,
    seed: Math.floor(Math.random() * 2_147_483_647),
  };
  if (features.supports_steps === true) {
    body.steps = numberValue(defaults.steps) ?? numberValue(limits.min_steps) ?? 1;
  }
  if (features.supports_guidance === true) {
    body.guidance = numberValue(defaults.guidance)
      ?? numberValue(defaults.guidance_scale)
      ?? numberValue(limits.min_guidance)
      ?? 1;
  }
  return body;
}

export async function createVideoJob(
  input: VideoInput,
  requestKey?: string | null,
): Promise<DeApiJob> {
  const apiKey = resolveApiKey(requestKey);
  const models = await getVideoModels(apiKey);
  const configuredSlug = process.env.DEAPI_VIDEO_MODEL?.trim();
  const candidates = configuredSlug
    ? models.filter((model) => model.slug === configuredSlug)
    : [
        ...models.filter((model) => model.slug === "Ltxv_13B_0_9_8_Distilled_FP8"),
        ...models.filter((model) => model.slug !== "Ltxv_13B_0_9_8_Distilled_FP8"),
      ];
  if (configuredSlug && candidates.length === 0) {
    throw new DeApiError(
      `The configured video model "${configuredSlug}" is not enabled for this deAPI account.`,
      422,
    );
  }

  let selectedBody: Record<string, string | number | boolean> | undefined;
  let lastModelError: unknown;
  for (const model of candidates) {
    try {
      selectedBody = getVideoParameters(model, input);
      break;
    } catch (error) {
      lastModelError = error;
      if (configuredSlug || !(error instanceof DeApiError)) throw error;
    }
  }
  if (!selectedBody) {
    if (lastModelError instanceof Error) throw lastModelError;
    throw new DeApiError("No enabled video model supports these settings.", 422);
  }
  const response = await deapiRequest<{ data?: DeApiJob }>(
    "/api/v2/videos/generations",
    apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selectedBody),
    },
  );
  const requestId = response.data?.request_id;
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new DeApiError("deAPI did not return a valid video job ID.", 502);
  }
  return { request_id: requestId };
}

export async function getJobStatus(
  requestId: string,
  requestKey?: string | null,
): Promise<JobStatus> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new DeApiError("The generation job ID is invalid.", 400);
  }
  const apiKey = resolveApiKey(requestKey);
  const response = await deapiRequest<{ data?: JobStatus }>(
    `/api/v2/jobs/${encodeURIComponent(requestId)}`,
    apiKey,
  );
  const job = response.data;
  if (!job || typeof job.status !== "string") {
    throw new DeApiError("deAPI returned an invalid job status.", 502);
  }
  if (job.result_url && !job.result_url.startsWith("https://")) {
    throw new DeApiError("deAPI returned an invalid media URL.", 502);
  }
  if (!job.error && job.message && ["failed", "error", "cancelled"].includes(job.status.toLowerCase())) {
    job.error = job.message;
  }
  return job;
}
