const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { getAddress, verifyMessage } = require("ethers");

const SESSION_TTL_SECONDS = 60 * 60;
const NONCE_TTL_SECONDS = 5 * 60;
const MAX_SAVED_JOBS = 10;
const VIDEO_MODEL = "minimax/h3-max/text-to-video";
const MUSIC_MODEL = "fal-ai/ace-step";
const QUEUE_ROOT = "https://queue.fal.run";

function allowedWallet() {
  const configured = process.env.FROSTWAVE_ALLOWED_WALLET;
  if (!configured || !/^0x[0-9a-f]{40}$/i.test(configured)) {
    throw new Error("Set FROSTWAVE_ALLOWED_WALLET in Vercel to the wallet address allowed to generate.");
  }
  try {
    return getAddress(configured).toLowerCase();
  } catch {
    throw new Error("FROSTWAVE_ALLOWED_WALLET must be a valid EVM wallet address.");
  }
}

function secret() {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("Fal.ai isn't configured. Add FAL_KEY to the Vercel environment variables and redeploy.");
  return createHmac("sha256", key).update("frostwave-vercel-session-v1").digest();
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
  if (claims.address !== allowedWallet()) {
    throw new Error("This wallet isn't allowed to use Fal generation.");
  }
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
    || !/^[a-zA-Z0-9-]{8,128}$/.test(job.requestId)
    || !Number.isSafeInteger(job.createdAt)
  ) {
    throw new Error("This generation job is invalid or belongs to another wallet.");
  }
  return job;
}

function makeJobId(kind, address, requestId, metadata) {
  return encodeSigned({
    type: "job",
    kind,
    address,
    requestId,
    createdAt: Math.floor(Date.now() / 1000),
    ...metadata,
  });
}

async function falRequest(url, method = "GET", payload) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail || body?.error || body?.message;
    throw new Error(typeof detail === "string" ? detail.slice(0, 1000) : `fal.ai returned HTTP ${response.status}.`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("fal.ai returned an invalid response.");
  }
  return body;
}

function queueUrl(value) {
  if (typeof value !== "string") throw new Error("fal.ai didn't return a valid queue URL.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "queue.fal.run" || parsed.port) {
    throw new Error("fal.ai returned an unexpected queue URL.");
  }
  return value;
}

function mediaUrl(value) {
  if (typeof value !== "string") throw new Error("fal.ai didn't return a media URL.");
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || !(host === "fal.media" || host.endsWith(".fal.media") || host === "storage.googleapis.com")
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    throw new Error("fal.ai returned an unexpected media URL.");
  }
  return value;
}

async function readJobStatus(job, includeMedia = false) {
  const statusUrl = queueUrl(job.statusUrl);
  const status = await falRequest(statusUrl);
  const state = status.status;
  if (state === "COMPLETED") {
    if (!includeMedia) {
      return {
        status: "complete",
        progress: 100,
        completed_clips: job.kind === "video" ? 1 : undefined,
        total_clips: job.kind === "video" ? 1 : undefined,
        message: job.kind === "video" ? "Your short video is ready." : "Your song is ready.",
      };
    }
    const result = await falRequest(queueUrl(job.responseUrl));
    const file = job.kind === "video" ? result.video : result.audio;
    const url = mediaUrl(file?.url);
    return {
      status: "complete",
      progress: 100,
      completed_clips: job.kind === "video" ? 1 : undefined,
      total_clips: job.kind === "video" ? 1 : undefined,
      message: job.kind === "video" ? "Your short video is ready." : "Your song is ready.",
      media_url: url,
    };
  }
  if (state === "FAILED" || state === "CANCELLED") {
    const detail = status.error || status.message;
    return {
      status: "failed",
      progress: 0,
      message: typeof detail === "string" ? detail.slice(0, 1000) : `fal.ai request ${state.toLowerCase()}.`,
    };
  }
  const queued = state === "IN_QUEUE";
  return {
    status: queued ? "queued" : "rendering",
    progress: queued ? 0 : 25,
    message: queued ? "Waiting in the fal.ai queue." : "fal.ai is generating your media.",
  };
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
    if (address.toLowerCase() !== allowedWallet()) {
      throw new Error("This wallet isn't allowed to use Fal generation.");
    }
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
    const configured = Boolean(process.env.FAL_KEY?.trim());
    let walletConfigured = false;
    try {
      allowedWallet();
      walletConfigured = true;
    } catch {
      walletConfigured = false;
    }
    return res.status(200).json({
      ready: configured && walletConfigured,
      provider: "fal.ai",
      gpu: null,
      message: !configured
        ? "Add FAL_KEY to the Vercel environment variables, then redeploy."
        : !walletConfigured
          ? "Add FROSTWAVE_ALLOWED_WALLET to Vercel with the allowed public wallet address, then redeploy."
          : "fal.ai is ready. Generation may consume account credits or be billed.",
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
    const ratios = { landscape: "16:9", portrait: "9:16", square: "1:1" };
    if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 1000) throw new Error("Describe the video you want to make.");
    if (!ratios[format]) throw new Error("Choose landscape, portrait, or square format.");
    if (!styles[style]) throw new Error("Choose one of the available visual styles.");
    const request = await falRequest(`${QUEUE_ROOT}/${VIDEO_MODEL}`, "POST", {
      prompt: `${prompt.trim()} Visual style: ${styles[style]}`,
      duration: 5,
      resolution: "480P",
      aspect_ratio: ratios[format],
      prompt_expansion_mode: "disabled",
      enable_safety_checker: true,
    });
    if (typeof request.request_id !== "string") throw new Error("fal.ai didn't return a valid video request ID.");
    const statusUrl = queueUrl(request.status_url);
    const responseUrl = queueUrl(request.response_url);
    const id = makeJobId("video", address, request.request_id, {
      statusUrl,
      responseUrl,
    });
    return res.status(202).json({
      id,
      model: "MiniMax H3 Max · fal.ai (5 seconds)",
      prompt: prompt.trim(),
      status: "queued",
      progress: 0,
      completed_clips: 0,
      total_clips: 1,
      message: "Waiting in the fal.ai queue.",
      created_at: Math.floor(Date.now() / 1000),
    });
  }
  if (path === "/api/video/jobs" && req.method === "GET") {
    const jobs = await Promise.all(parseJobIds(req.query.ids).map(async (id) => {
      const job = decodeSigned(id);
      if (job.type !== "job" || job.kind !== "video" || job.address !== address) return null;
      const result = await readJobStatus(job);
      return { id, model: "MiniMax H3 Max · fal.ai (5 seconds)", ...result };
    }));
    return res.status(200).json({ jobs: jobs.filter(Boolean) });
  }
  const match = path.match(/^\/api\/video\/jobs\/([^/]+)(?:\/(ticket))?$/);
  if (match && req.method === "GET" && !match[2]) {
    const job = getJob({ ...req, query: { ...req.query, id: decodeURIComponent(match[1]) } }, "video", address);
    const result = await readJobStatus(job);
    return res.status(200).json({
      id: decodeURIComponent(match[1]),
      model: "MiniMax H3 Max · fal.ai (5 seconds)",
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
    throw new Error("Fal.ai music generation doesn't support reference audio uploads.");
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
    if (body.reference_audio_id) throw new Error("Fal.ai music generation doesn't support reference audio uploads.");
    const prompt = body.prompt.trim();
    const genre = body.genre.trim();
    const tags = `${genre}, ${prompt}${body.vocal_style === "Instrumental" ? ", instrumental, no vocals" : ""}`;
    const lyrics = body.vocal_style === "Instrumental" ? "[inst]" : body.lyrics.trim();
    const request = await falRequest(`${QUEUE_ROOT}/${MUSIC_MODEL}`, "POST", {
      tags,
      lyrics,
      duration: body.duration,
      enable_safety_checker: true,
    });
    if (typeof request.request_id !== "string") throw new Error("fal.ai didn't return a valid music request ID.");
    const statusUrl = queueUrl(request.status_url);
    const responseUrl = queueUrl(request.response_url);
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
    const id = makeJobId("music", address, request.request_id, { statusUrl, responseUrl });
    return res.status(202).json({
      id,
      ...publicJob,
      status: "queued",
      message: "Waiting in the fal.ai queue.",
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

// Outside Next.js, Vercel doesn't reliably expose the `[...path]` catch-all as
// `req.query.path`, so the request URL is the source of truth for routing.
function resolveApiPath(req) {
  const pathname = typeof req.url === "string" ? new URL(req.url, "http://localhost").pathname : "";
  if (pathname.startsWith("/api/")) return pathname.replace(/\/+$/, "");
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
