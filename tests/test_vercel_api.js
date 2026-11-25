const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { Wallet } = require("ethers");
const { handleApiRequest } = require("../vercel-api");
const apiHandler = require("../api/index.js");

const wallet = Wallet.createRandom();
const previousEnvironment = {
  FAL_KEY: process.env.FAL_KEY,
};
const previousFetch = global.fetch;
process.env.FAL_KEY = "test-fal-key";

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

test("Vercel catch-all routes health and returns auth failures as 401", async () => {
  const healthResponse = makeResponse();
  await apiHandler(makeRequest("/api/video/health"), healthResponse);
  assert.equal(healthResponse.statusCode, 200);
  assert.equal(healthResponse.body.ready, true);

  const jobsResponse = makeResponse();
  await apiHandler(makeRequest("/api/video/jobs"), jobsResponse);
  assert.equal(jobsResponse.statusCode, 401);
});

test("Fal video requests use the server key and return signed job IDs", async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      status_url: "https://queue.fal.run/model/requests/123e4567-e89b-12d3-a456-426614174000/status",
      response_url: "https://queue.fal.run/model/requests/123e4567-e89b-12d3-a456-426614174000",
    }), { status: 200 });
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
  assert.equal(calls[0].options.headers.Authorization, "Key test-fal-key");
  assert.equal(JSON.parse(calls[0].options.body).duration, 5);
});

test("video queue status returns only the generated media URL", async () => {
  global.fetch = async (url, options) => {
    if (options?.method === "POST") {
      return new Response(JSON.stringify({
        request_id: "223e4567-e89b-12d3-a456-426614174000",
        status_url: "https://queue.fal.run/model/requests/223e4567-e89b-12d3-a456-426614174000/status",
        response_url: "https://queue.fal.run/model/requests/223e4567-e89b-12d3-a456-426614174000",
      }), { status: 200 });
    }
    return new Response(JSON.stringify(
      String(url).endsWith("/status")
        ? { status: "COMPLETED" }
        : { video: { url: "https://v3b.fal.media/generated.mp4" } },
    ), { status: 200 });
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
  assert.equal(ticketResponse.body.video_url, "https://v3b.fal.media/generated.mp4");
});

test("Fal music requests disable public sharing and preserve user metadata", async () => {
  global.fetch = async () => new Response(JSON.stringify({
    request_id: "323e4567-e89b-12d3-a456-426614174000",
    status_url: "https://queue.fal.run/music/requests/323e4567-e89b-12d3-a456-426614174000/status",
    response_url: "https://queue.fal.run/music/requests/323e4567-e89b-12d3-a456-426614174000",
  }), { status: 200 });
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

  global.fetch = async (url) => new Response(JSON.stringify(
    String(url).endsWith("/status")
      ? { status: "COMPLETED" }
      : { audio: { url: "https://v3b.fal.media/generated.mp3" } },
  ), { status: 200 });
  const ticketResponse = await callApi(`/api/music/jobs/${encodeURIComponent(response.body.id)}/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(ticketResponse.statusCode, 200);
  assert.equal(ticketResponse.body.audio_url, "https://v3b.fal.media/generated.mp3");
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
