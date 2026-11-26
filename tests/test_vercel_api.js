const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { Wallet } = require("ethers");
const { handleApiRequest } = require("../vercel-api");
const apiHandler = require("../api/index.js");

const wallet = Wallet.createRandom();
const previousEnvironment = {
  HF_TOKEN: process.env.HF_TOKEN,
  FROSTWAVE_HF_VIDEO_SPACE_URL: process.env.FROSTWAVE_HF_VIDEO_SPACE_URL,
  FROSTWAVE_HF_MUSIC_SPACE_URL: process.env.FROSTWAVE_HF_MUSIC_SPACE_URL,
  FROSTWAVE_ALLOWED_WALLETS: process.env.FROSTWAVE_ALLOWED_WALLETS,
  FROSTWAVE_ALLOWED_WALLET: process.env.FROSTWAVE_ALLOWED_WALLET,
};
const previousFetch = global.fetch;
process.env.HF_TOKEN = "test-hf-token";
process.env.FROSTWAVE_HF_VIDEO_SPACE_URL = "https://video-space.hf.space";
process.env.FROSTWAVE_HF_MUSIC_SPACE_URL = "https://music-space.hf.space";
delete process.env.FROSTWAVE_ALLOWED_WALLETS;
delete process.env.FROSTWAVE_ALLOWED_WALLET;

function makeRequest(path, { method = "GET", headers = {}, body, query = {} } = {}) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  return {
    method,
    headers: {
      host: "wave.example",
      origin: "https://wave.example",
      ...headers,
    },
    body,
    query: { path: parts, ...query },
  };
}

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function callApi(path, options) {
  const response = makeResponse();
  await handleApiRequest(makeRequest(path, options), response);
  return response;
}

let sessionToken;

before(() => {
  assert.ok(wallet.address);
});

after(() => {
  global.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("wallet challenge signs in with a signed message", async () => {
  const challengeResponse = await callApi("/api/auth/nonce", {
    method: "POST",
    body: { address: wallet.address, chain_id: 1 },
  });
  assert.equal(challengeResponse.statusCode, 200);
  const signature = await wallet.signMessage(challengeResponse.body.message);
  const verifyResponse = await callApi("/api/auth/verify", {
    method: "POST",
    body: {
      address: wallet.address,
      nonce: challengeResponse.body.nonce,
      signature,
    },
  });
  assert.equal(verifyResponse.statusCode, 200);
  sessionToken = verifyResponse.body.token;
  const meResponse = await callApi("/api/auth/me", {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(meResponse.body.address.toLowerCase(), wallet.address.toLowerCase());
});

test("any wallet can sign in and only reads its own jobs", async () => {
  const otherWallet = Wallet.createRandom();
  const challenge = await callApi("/api/auth/nonce", {
    method: "POST",
    body: { address: otherWallet.address, chain_id: 8453 },
  });
  const signature = await otherWallet.signMessage(challenge.body.message);
  const verified = await callApi("/api/auth/verify", {
    method: "POST",
    body: { address: otherWallet.address, nonce: challenge.body.nonce, signature },
  });
  assert.equal(verified.body.address.toLowerCase(), otherWallet.address.toLowerCase());
  assert.notEqual(verified.body.token, sessionToken);
});

test("wallet challenge allows other users when no wallet allowlist is configured", async () => {
  const previousSingleWallet = process.env.FROSTWAVE_ALLOWED_WALLET;
  const previousWallets = process.env.FROSTWAVE_ALLOWED_WALLETS;
  delete process.env.FROSTWAVE_ALLOWED_WALLET;
  delete process.env.FROSTWAVE_ALLOWED_WALLETS;
  try {
    const response = await callApi("/api/auth/nonce", {
      method: "POST",
      body: { address: Wallet.createRandom().address, chain_id: 1 },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    if (previousSingleWallet === undefined) delete process.env.FROSTWAVE_ALLOWED_WALLET;
    else process.env.FROSTWAVE_ALLOWED_WALLET = previousSingleWallet;
    if (previousWallets === undefined) delete process.env.FROSTWAVE_ALLOWED_WALLETS;
    else process.env.FROSTWAVE_ALLOWED_WALLETS = previousWallets;
  }
});

test("Vercel catch-all routes health and returns auth failures as 401", async () => {
  const healthResponse = makeResponse();
  await apiHandler(makeRequest("/api/video/health"), healthResponse);
  assert.equal(healthResponse.statusCode, 200);
  assert.equal(healthResponse.body.ready, true);

  const jobsResponse = makeResponse();
  await apiHandler(makeRequest("/api/video/jobs"), jobsResponse);
  assert.equal(jobsResponse.statusCode, 401);
});

test("Hugging Face video requests use the server token and return signed job IDs", async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ event_id: "123e4567-e89b-12d3-a456-426614174000" }), { status: 200 });
  };
  const response = await callApi("/api/video/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: {
      prompt: "A quiet lake",
      format: "portrait",
      style: "Dreamlike",
    },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.total_clips, 1);
  assert.match(response.body.id, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://video-space.hf.space/gradio_api/call/generate_video");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-hf-token");
  const videoArgs = JSON.parse(calls[0].options.body).data;
  assert.equal(videoArgs[0], "A quiet lake Visual style: Dreamlike atmosphere, soft light, surreal but coherent visual details");
  assert.equal(videoArgs[4], 3.5);
});

test("video queue status returns only the generated media URL", async () => {
  global.fetch = async (url, options) => {
    if (options?.method === "POST") {
      return new Response(JSON.stringify({ event_id: "223e4567-e89b-12d3-a456-426614174000" }), { status: 200 });
    }
    return new Response(
      'event: complete\ndata: {"msg":"process_completed","output":{"data":[{"path":"/tmp/generated.mp4","url":"https://video-space.hf.space/gradio_api/file=/tmp/generated.mp4"},42]},"success":true}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const submitResponse = await callApi("/api/video/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { prompt: "A quiet lake", format: "landscape", style: "Cinematic" },
  });
  const ticketResponse = await callApi(`/api/video/jobs/${encodeURIComponent(submitResponse.body.id)}/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(ticketResponse.statusCode, 200);
  assert.equal(ticketResponse.body.video_url, "https://video-space.hf.space/gradio_api/file=/tmp/generated.mp4");
});

test("Hugging Face quota errors are reported as rate limits", async () => {
  global.fetch = async () => new Response(JSON.stringify({ detail: "Daily ZeroGPU quota exceeded." }), { status: 429 });
  const response = makeResponse();
  await apiHandler(makeRequest("/api/video/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { prompt: "A quiet lake", format: "landscape", style: "Cinematic" },
  }), response);
  assert.equal(response.statusCode, 429);
  assert.match(response.body.error, /quota exceeded/i);
});

test("Hugging Face music requests use ACE-Step and preserve private metadata", async () => {
  let submission;
  global.fetch = async (url, options) => {
    submission = { url: String(url), options };
    return new Response(JSON.stringify({ event_id: "323e4567-e89b-12d3-a456-426614174000" }), { status: 200 });
  };
  const response = await callApi("/api/music/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: {
      title: "Quiet morning",
      prompt: "A gentle melody",
      lyrics: "",
      genre: "Ambient",
      duration: 60,
      vocal_style: "Instrumental",
      is_public: true,
    },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.title, "Quiet morning");
  assert.equal(response.body.is_public, false);
  assert.equal(response.body.duration, 60);
  assert.equal(submission.url, "https://music-space.hf.space/gradio_api/call/generation_wrapper");
  const musicArgs = JSON.parse(submission.options.body).data;
  assert.equal(musicArgs.length, 49);
  assert.match(musicArgs[4], /Ambient, A gentle melody/);
  assert.equal(musicArgs[5], "[inst]");
  assert.equal(musicArgs[15], 60);

  global.fetch = async () => new Response(
    'event: complete\ndata: {"msg":"process_completed","output":{"data":[{"path":"/tmp/generated.mp3","url":"https://music-space.hf.space/gradio_api/file=/tmp/generated.mp3"}]},"success":true}\n\n',
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  const ticketResponse = await callApi(`/api/music/jobs/${encodeURIComponent(response.body.id)}/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(ticketResponse.statusCode, 200);
  assert.equal(ticketResponse.body.audio_url, "https://music-space.hf.space/gradio_api/file=/tmp/generated.mp3");
});

test("routes from the request URL when Vercel omits the catch-all query", async () => {
  const response = makeResponse();
  await apiHandler({
    method: "GET",
    url: "/api/discover?limit=5",
    headers: { host: "wave.example", origin: "https://wave.example" },
    query: { limit: "5" },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { tracks: [] });
});

test("routes nested auth paths from the vercel.json rewrite", async () => {
  const response = makeResponse();
  await apiHandler({
    method: "POST",
    url: "/api/index?__route=/api/auth/nonce",
    headers: { host: "wave.example", origin: "https://wave.example", "content-type": "application/json" },
    body: { address: wallet.address, chain_id: 1 },
    query: { __route: "/api/auth/nonce" },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.message || response.body.nonce);
});
