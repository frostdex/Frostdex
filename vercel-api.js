const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { getAddress, verifyMessage } = require("ethers");

const SESSION_TTL_SECONDS = 60 * 60;
const NONCE_TTL_SECONDS = 5 * 60;
const MAX_SAVED_JOBS = 10;
const VIDEO_SPACE_DEFAULT = "https://upsampler-wan-2-2-14b-text-to-video.hf.space";
const MUSIC_SPACE_DEFAULT = "https://ace-step-ace-step-v1-5.hf.space";
const VIDEO_MODEL = "Wan 2.2 14B · Hugging Face ZeroGPU (3.5 seconds)";
const MUSIC_MODEL = "ACE-Step v1.5 · Hugging Face ZeroGPU";
const SPACE_REQUEST_TIMEOUT_MS = 7_000;

function walletAllowlist() {
  const configured = process.env.FROSTWAVE_ALLOWED_WALLETS || process.env.FROSTWAVE_ALLOWED_WALLET;
  if (!configured?.trim()) return null;
  const addresses = configured.split(",").map((address) => address.trim()).filter(Boolean);
  if (!addresses.length || addresses.some((address) => !/^0x[0-9a-f]{40}$/i.test(address))) {
    throw new Error("FROSTWAVE_ALLOWED_WALLETS must contain valid comma-separated EVM wallet addresses.");
  }
  try {
    return new Set(addresses.map((address) => getAddress(address).toLowerCase()));
  } catch {
    throw new Error("FROSTWAVE_ALLOWED_WALLETS must contain valid EVM wallet addresses.");
  }
}

function assertWalletAllowed(address) {
  const allowlist = walletAllowlist();
  if (allowlist && !allowlist.has(address.toLowerCase())) {
    throw new Error("This wallet isn't allowed to use generation.");
  }
}

function secret() {
  const key = process.env.HF_TOKEN?.trim();
  if (!key) throw new Error("Set HF_TOKEN in Vercel to a Hugging Face read token, then redeploy.");
  return createHmac("sha256", key).update("frostwave-vercel-session-v1").digest();
}

function spaceBase(kind) {
  const configured = kind === "video"
    ? process.env.FROSTWAVE_HF_VIDEO_SPACE_URL
    : process.env.FROSTWAVE_HF_MUSIC_SPACE_URL;
  const parsed = new URL(configured || (kind === "video" ? VIDEO_SPACE_DEFAULT : MUSIC_SPACE_DEFAULT));
  if (
    parsed.protocol !== "https:"
    || !parsed.hostname.toLowerCase().endsWith(".hf.space")
    || parsed.port
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`FROSTWAVE_HF_${kind.toUpperCase()}_SPACE_URL must be an HTTPS Hugging Face Space origin.`);
  }
  return parsed.origin;
}

function mac(value) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encodeSigned(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

function decodeSigned(token) {
  if (typeof token !== "string" || token.length > 4096) throw new Error("Invalid or expired token.");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(signature, mac(payload))) {
    throw new Error("Invalid or expired token.");
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid or expired token.");
  }
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || !host) throw new Error("A valid website origin is required.");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("A valid website origin is required.");
  }
  if (
    parsed.host.toLowerCase() !== String(host).split(",")[0].trim().toLowerCase()
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")
  ) {
    throw new Error("This website origin isn't allowed.");
  }
  return parsed.origin;
}

function getAddressFromToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error("Connect your wallet to access this feature.");
  }
  const claims = decodeSigned(authorization.slice(7).trim());
  if (
    claims.type !== "session"
    || typeof claims.address !== "string"
    || !Number.isSafeInteger(claims.exp)
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Your sign-in expired. Connect your wallet again.");
  }
  assertWalletAllowed(claims.address);
  return claims.address;
}

function requireBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new Error("Request body must be a JSON object.");
  }
  return req.body;
}

function getJob(req, kind, expectedAddress) {
  const job = decodeSigned(req.query.id);
  if (
    job.type !== "job"
    || job.kind !== kind
    || job.address !== expectedAddress
    || typeof job.requestId !== "string"
    || !/^[a-zA-Z0-9._-]{8,128}$/.test(job.requestId)
    || typeof job.spaceUrl !== "string"
    || typeof job.apiName !== "string"
    || !Number.isSafeInteger(job.createdAt)
  ) {
    throw new Error("This generation job is invalid or belongs to another wallet.");
  }
  if (job.spaceUrl !== spaceBase(kind)) throw new Error("This generation job belongs to another provider.");
  const expectedApiName = kind === "video" ? "generate_video" : "generation_wrapper";
  if (job.apiName !== expectedApiName) throw new Error("This generation job has an invalid provider endpoint.");
  return job;
}

function makeJobId(kind, address, eventId, metadata) {
  return encodeSigned({
    type: "job",
    kind,
    address,
    requestId: eventId,
    createdAt: Math.floor(Date.now() / 1000),
    ...metadata,
  });
}

function spaceHeaders(json = false) {
  return {
    ...(process.env.HF_TOKEN?.trim() ? { Authorization: `Bearer ${process.env.HF_TOKEN.trim()}` } : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function submitSpaceJob(kind, data) {
  const base = spaceBase(kind);
  const apiName = kind === "video" ? "generate_video" : "generation_wrapper";
  const response = await fetch(`${base}/gradio_api/call/${apiName}`, {
    method: "POST",
    headers: spaceHeaders(true),
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(SPACE_REQUEST_TIMEOUT_MS),
  });
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = null;
  }
  if (!response.ok) {
    const detail = result?.detail || result?.error || result?.message;
    const message = typeof detail === "string"
      ? detail.slice(0, 1000)
      : responseText.slice(0, 1000) || "Request failed.";
    throw new Error(`Hugging Face Space returned HTTP ${response.status}: ${message}`);
  }
  if (!result || typeof result.event_id !== "string" || !/^[A-Za-z0-9._-]{8,128}$/.test(result.event_id)) {
    throw new Error("Hugging Face Space didn't return a valid generation event ID.");
  }
  return { base, apiName, eventId: result.event_id };
}

function parseSpaceEvent(block) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data) return null;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("Hugging Face Space returned an invalid event.");
  }
  const message = payload?.msg;
  if (event === "error" || message === "process_errored" || payload?.success === false) {
    const detail = payload?.error || payload?.output?.error || payload?.message;
    throw new Error(typeof detail === "string" ? detail.slice(0, 1000) : "Hugging Face ZeroGPU couldn't complete the generation.");
  }
  if (event === "complete" || message === "process_completed") return payload;
  return null;
}

async function readSpaceEvent(job) {
  const url = `${job.spaceUrl}/gradio_api/call/${job.apiName}/${encodeURIComponent(job.requestId)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { ...spaceHeaders(), Accept: "text/event-stream" },
      signal: AbortSignal.timeout(SPACE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") return null;
    throw error;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`Hugging Face Space returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  if (!response.body) throw new Error("Hugging Face Space returned an empty event stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return buffer ? parseSpaceEvent(buffer) : null;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error("Hugging Face Space returned an oversized event.");
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const event = parseSpaceEvent(block);
        if (event) return event;
      }
    }
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") return null;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function eventOutput(event) {
  return event?.output?.data || event?.data || event?.output || event;
}

function findMediaFile(event, kind, base) {
  const output = eventOutput(event);
  const first = Array.isArray(output) ? output[0] : output;
  const value = typeof first === "string" ? first : first?.url;
  if (typeof value !== "string" || !value) {
    throw new Error("Hugging Face Space completed without returning a media file.");
  }
  const parsed = new URL(value, base);
  const expected = new URL(base);
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== expected.origin
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    throw new Error("Hugging Face Space returned an unexpected media URL.");
  }
  const expectedExtension = kind === "video" ? /\.(mp4|webm)(?:$|[?#])/i : /\.(mp3|wav|flac|ogg)(?:$|[?#])/i;
  if (!expectedExtension.test(parsed.pathname + parsed.search)) {
    throw new Error("Hugging Face Space returned a media URL with an unexpected file type.");
  }
  return parsed.toString();
}

async function readJobStatus(job, includeMedia = false) {
  const event = await readSpaceEvent(job);
  if (!event) {
    const queued = Date.now() / 1000 - job.createdAt < 30;
    return {
      status: queued ? "queued" : "rendering",
      progress: queued ? 0 : 25,
      message: queued
        ? "Waiting in Hugging Face ZeroGPU's queue."
        : "Hugging Face ZeroGPU is generating your media.",
    };
  }
  const output = eventOutput(event);
  if (event?.success === false || event?.output?.error) {
    const detail = event.output?.error || event.error || event.message;
    return {
      status: "failed",
      progress: 0,
      message: typeof detail === "string" ? detail.slice(0, 1000) : "Hugging Face ZeroGPU couldn't complete the generation.",
    };
  }
  const result = {
    status: "complete",
    progress: 100,
    completed_clips: job.kind === "video" ? 1 : undefined,
    total_clips: job.kind === "video" ? 1 : undefined,
    message: job.kind === "video" ? "Your short video is ready." : "Your song is ready.",
  };
  if (includeMedia) result.media_url = findMediaFile({ output }, job.kind, job.spaceUrl);
  return result;
}

function challengeMessage(origin, address, chainId, nonce, issuedAt, expiresAt) {
  const domain = new URL(origin).host;
  return `${domain} wants you to sign in with your Ethereum account:\n${getAddress(address)}\n\nSign in to Frostwave.\n\nURI: ${origin}/\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
}

async function handleAuth(req, res, path) {
  if (path === "/api/auth/nonce" && req.method === "POST") {
    const origin = requireSameOrigin(req);
    const body = requireBody(req);
    if (typeof body.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(body.address)) {
      throw new Error("Connect a valid EVM wallet address.");
    }
    if (!Number.isSafeInteger(body.chain_id) || body.chain_id < 1) {
      throw new Error("The connected wallet returned an invalid chain ID.");
    }
    const address = getAddress(body.address);
    assertWalletAllowed(address);
    const issued = Math.floor(Date.now() / 1000);
    const nonce = encodeSigned({
      type: "nonce",
      address: address.toLowerCase(),
      chainId: body.chain_id,
      origin,
      issued,
      random: randomBytes(16).toString("hex"),
    });
    const issuedAt = new Date(issued * 1000).toISOString().replace(".000Z", "Z");
    const expiresAt = new Date((issued + NONCE_TTL_SECONDS) * 1000).toISOString().replace(".000Z", "Z");
    return res.status(200).json({
      message: challengeMessage(origin, address, body.chain_id, nonce, issuedAt, expiresAt),
      nonce,
      expires_in: NONCE_TTL_SECONDS,
    });
  }
  if (path === "/api/auth/verify" && req.method === "POST") {
    const origin = requireSameOrigin(req);
    const body = requireBody(req);
    if (
      typeof body.address !== "string"
      || !/^0x[0-9a-f]{40}$/i.test(body.address)
      || typeof body.nonce !== "string"
      || typeof body.signature !== "string"
    ) {
      throw new Error("Wallet signature is missing or invalid.");
    }
    const challenge = decodeSigned(body.nonce);
    const now = Math.floor(Date.now() / 1000);
    if (
      challenge.type !== "nonce"
      || challenge.origin !== origin
      || challenge.address !== body.address.toLowerCase()
      || !Number.isSafeInteger(challenge.chainId)
      || !Number.isSafeInteger(challenge.issued)
      || challenge.issued > now
      || challenge.issued + NONCE_TTL_SECONDS < now
    ) {
      throw new Error("Invalid or expired wallet challenge. Please try again.");
    }
    const address = getAddress(body.address);
    const issuedAt = new Date(challenge.issued * 1000).toISOString().replace(".000Z", "Z");
    const expiresAt = new Date((challenge.issued + NONCE_TTL_SECONDS) * 1000).toISOString().replace(".000Z", "Z");
    const message = challengeMessage(origin, address, challenge.chainId, body.nonce, issuedAt, expiresAt);
    let signer;
    try {
      signer = verifyMessage(message, body.signature);
    } catch {
      throw new Error("Couldn't verify the wallet signature.");
    }
    if (signer.toLowerCase() !== address.toLowerCase()) {
      throw new Error("The signature doesn't match the connected wallet.");
    }
    const token = encodeSigned({
      type: "session",
      address: signer.toLowerCase(),
      exp: now + SESSION_TTL_SECONDS,
    });
    return res.status(200).json({ token, address: signer, expires_in: SESSION_TTL_SECONDS });
  }
  if (path === "/api/auth/me" && req.method === "GET") {
    return res.status(200).json({ address: getAddress(getAddressFromToken(req)) });
  }
  if (path === "/api/auth/logout" && req.method === "POST") {
    getAddressFromToken(req);
    return res.status(200).json({ signed_out: true });
  }
  return false;
}

function parseJobIds(value) {
  if (typeof value !== "string" || value.length > 10_000) return [];
  return [...new Set(value.split(",").filter(Boolean))].slice(0, MAX_SAVED_JOBS);
}

async function handleVideo(req, res, path) {
  if (path === "/api/video/health" && req.method === "GET") {
    const configured = Boolean(process.env.HF_TOKEN?.trim());
    let spacesConfigured = true;
    let walletConfigValid = true;
    try {
      spaceBase("video");
      spaceBase("music");
    } catch {
      spacesConfigured = false;
    }
    try {
      walletAllowlist();
    } catch {
      walletConfigValid = false;
    }
    return res.status(200).json({
      ready: configured && spacesConfigured && walletConfigValid,
      provider: "huggingface-zerogpu",
      gpu: null,
      message: !configured
        ? "Add HF_TOKEN to Vercel as a secret, then redeploy."
        : !spacesConfigured
          ? "Set valid HTTPS Hugging Face Space URLs in Vercel, then redeploy."
          : !walletConfigValid
            ? "Check the configured EVM wallet allowlist."
            : "Hugging Face ZeroGPU is configured. Free accounts have a limited daily GPU quota; provider availability can vary.",
      queued_jobs: 0,
    });
  }
  const address = getAddressFromToken(req);
  if (path === "/api/video/jobs" && req.method === "POST") {
    const body = requireBody(req);
    const prompt = body.prompt;
    const format = body.format;
    const style = body.style;
    const styles = {
      Cinematic: "Cinematic lighting, deliberate camera movement, film-like color grading",
      "Hand-drawn animation": "Hand-drawn animated film, expressive linework, cohesive illustrated frames",
      Dreamlike: "Dreamlike atmosphere, soft light, surreal but coherent visual details",
      Documentary: "Natural documentary cinematography, realistic lighting and camera movement",
      "Stop motion": "Tactile stop-motion animation, handcrafted miniature textures",
      Photoreal: "Photorealistic imagery, natural materials and believable movement",
    };
    const spaceRatios = {
      landscape: "16:9 (832x480)",
      portrait: "9:16 (480x832)",
      square: "1:1 (640x640)",
    };
    if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 1000) throw new Error("Describe the video you want to make.");
    if (!spaceRatios[format]) throw new Error("Choose landscape, portrait, or square format.");
    if (!styles[style]) throw new Error("Choose one of the available visual styles.");
    const { base, apiName, eventId } = await submitSpaceJob("video", [
      `${prompt.trim()} Visual style: ${styles[style]}`,
      spaceRatios[format],
      4,
      "low quality, blur, watermark, text",
      3.5,
      1,
      1,
      42,
      true,
    ]);
    const id = makeJobId("video", address, eventId, { spaceUrl: base, apiName });
    return res.status(202).json({
      id,
      model: VIDEO_MODEL,
      prompt: prompt.trim(),
      status: "queued",
      progress: 0,
      completed_clips: 0,
      total_clips: 1,
      message: "Waiting in Hugging Face ZeroGPU's queue.",
      created_at: Math.floor(Date.now() / 1000),
    });
  }
  if (path === "/api/video/jobs" && req.method === "GET") {
    const jobs = await Promise.all(parseJobIds(req.query.ids).map(async (id) => {
      const job = decodeSigned(id);
      if (job.type !== "job" || job.kind !== "video" || job.address !== address) return null;
      const result = await readJobStatus(job);
      return { id, model: VIDEO_MODEL, ...result };
    }));
    return res.status(200).json({ jobs: jobs.filter(Boolean) });
  }
  const match = path.match(/^\/api\/video\/jobs\/([^/]+)(?:\/(ticket))?$/);
  if (match && req.method === "GET" && !match[2]) {
    const job = getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "video", address);
    const result = await readJobStatus(job);
    return res.status(200).json({
      id: decodeURIComponent(match[1]),
      model: VIDEO_MODEL,
      total_clips: 1,
      completed_clips: result.completed_clips || 0,
      ...result,
    });
  }
  if (match && req.method === "POST" && match[2]) {
    const job = getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "video", address);
    const result = await readJobStatus(job, true);
    if (result.status !== "complete") throw new Error("This video isn't ready yet.");
    return res.status(200).json({ video_url: result.media_url, expires_in: 60 * 60 });
  }
  return false;
}

async function handleMusic(req, res, path) {
  const address = getAddressFromToken(req);
  if (path === "/api/music/uploads" && (req.method === "POST" || req.method === "DELETE")) {
    throw new Error("Reference audio uploads aren't supported by the Hugging Face music Space.");
  }
  if (path === "/api/music/jobs" && req.method === "POST") {
    const body = requireBody(req);
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.trim().length > 1000) {
      throw new Error("Add a music description of 1–1,000 characters.");
    }
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 80) {
      throw new Error("Add a title of 1–80 characters.");
    }
    if (typeof body.genre !== "string" || !body.genre.trim() || body.genre.length > 40) throw new Error("Choose a supported music style.");
    if (!Number.isSafeInteger(body.duration) || ![60, 120, 240].includes(body.duration)) {
      throw new Error("Choose a song length of 1, 2, or 4 minutes.");
    }
    if (!["With vocals", "Instrumental"].includes(body.vocal_style)) throw new Error("Choose a vocal style.");
    if (body.vocal_style === "With vocals" && (typeof body.lyrics !== "string" || !body.lyrics.trim())) {
      throw new Error("Add lyrics, or choose Instrumental.");
    }
    if (typeof body.lyrics === "string" && body.lyrics.length > 4000) throw new Error("Lyrics must be 4,000 characters or fewer.");
    if (body.reference_audio_id) throw new Error("Reference audio uploads aren't supported by the Hugging Face music Space.");
    const prompt = body.prompt.trim();
    const genre = body.genre.trim();
    const tags = `${genre}, ${prompt}${body.vocal_style === "Instrumental" ? ", instrumental, no vocals" : ""}`;
    const lyrics = body.vocal_style === "Instrumental" ? "[inst]" : body.lyrics.trim();
    const musicArguments = [
      "acestep-v15-xl-turbo",
      "custom",
      null,
      "unknown",
      tags,
      lyrics,
      0,
      "",
      "",
      "unknown",
      8,
      7,
      true,
      "-1",
      null,
      body.duration,
      1,
      null,
      "",
      0,
      -1,
      "Fill the audio semantic mask based on the given conditions:",
      1,
      "text2music",
      false,
      0,
      1,
      3,
      "ode",
      "",
      "mp3",
      0.85,
      true,
      2,
      0,
      0.9,
      "NO USER INPUT",
      true,
      true,
      true,
      false,
      true,
      false,
      false,
      0.5,
      8,
      null,
      [],
      false,
    ];
    const { base, apiName, eventId } = await submitSpaceJob("music", musicArguments);
    const publicJob = {
      title: body.title.trim(),
      genre,
      duration: body.duration,
      prompt,
      favorite: false,
      is_public: false,
      artist: `${address.slice(0, 6)}…${address.slice(-4)}`,
      audio_url: null,
    };
    const id = makeJobId("music", address, eventId, { spaceUrl: base, apiName });
    return res.status(202).json({
      id,
      ...publicJob,
      status: "queued",
      message: "Waiting in Hugging Face ZeroGPU's queue.",
      created_at: Math.floor(Date.now() / 1000),
    });
  }
  if (path === "/api/music/jobs" && req.method === "GET") {
    const jobs = await Promise.all(parseJobIds(req.query.ids).map(async (id) => {
      const job = decodeSigned(id);
      if (job.type !== "job" || job.kind !== "music" || job.address !== address) return null;
      const result = await readJobStatus(job);
      return { id, ...result };
    }));
    return res.status(200).json({ jobs: jobs.filter(Boolean) });
  }
  const match = path.match(/^\/api\/music\/jobs\/([^/]+)(?:\/(ticket|favorite))?$/);
  if (match && req.method === "GET" && !match[2]) {
    const job = getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "music", address);
    const result = await readJobStatus(job);
    return res.status(200).json({ id: decodeURIComponent(match[1]), ...result });
  }
  if (match && req.method === "POST" && match[2] === "ticket") {
    const job = getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "music", address);
    const result = await readJobStatus(job, true);
    if (result.status !== "complete") throw new Error("This song isn't ready yet.");
    return res.status(200).json({ audio_url: result.media_url, expires_in: 60 * 60 });
  }
  if (match && req.method === "POST" && match[2] === "favorite") {
    getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "music", address);
    return res.status(200).json({ favorite: true });
  }
  return false;
}

// Every /api/* request is rewritten (vercel.json) to the single /api/index
// function with the original route in `__route`. Outside Next.js Vercel doesn't
// route nested paths to a `[...path]` catch-all, hence the explicit rewrite.
function resolveApiPath(req) {
  const url = new URL(typeof req.url === "string" ? req.url : "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/api/index" || pathname === "/api") {
    const route = url.searchParams.get("__route");
    if (route && route.startsWith("/api/")) return route.replace(/\/+$/, "");
  }
  if (pathname.startsWith("/api/")) return pathname;
  const query = req.query || {};
  const captured = query.path ?? query["...path"];
  const parts = (Array.isArray(captured) ? captured : [captured])
    .filter(Boolean)
    .flatMap((part) => String(part).split("/"))
    .filter(Boolean);
  return `/api/${parts.join("/")}`;
}

async function handleApiRequest(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  const path = resolveApiPath(req);
  if (path === "/api/discover" && req.method === "GET") return res.status(200).json({ tracks: [] });
  if (path.startsWith("/api/auth/")) return handleAuth(req, res, path);
  if (path === "/api/video/health") return handleVideo(req, res, path);
  if (path.startsWith("/api/video/jobs")) return handleVideo(req, res, path);
  if (path.startsWith("/api/music/")) return handleMusic(req, res, path);
  return false;
}

module.exports = { handleApiRequest };
