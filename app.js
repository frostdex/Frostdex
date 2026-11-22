const STORAGE_KEY = "frostwave-library-v1";
const ideas = [
  "A warm, slow-dancing soul song for a kitchen at midnight",
  "An instrumental soundtrack for getting lost in a new city",
  "A bright indie-pop song about the first day of summer",
  "A hazy lo-fi beat for watching the rain from the window",
  "A playful funk groove about a dog who thinks it's a detective",
];
const discoveries = [
  { title: "Window Seat", artist: "mira june", genre: "Chill", art: "art-peach", symbol: "☼", description: "Soft soul · late afternoon" },
  { title: "Little Satellites", artist: "daytrip club", genre: "Indie", art: "art-blue", symbol: "✳", description: "Bedroom pop · finding your people" },
  { title: "Blue Hour Loop", artist: "softsignal", genre: "Electronic", art: "art-lilac", symbol: "◌", description: "Downtempo · just before night" },
  { title: "Sunday in the Kitchen", artist: "juniper lane", genre: "Indie", art: "art-green", symbol: "❋", description: "Indie folk · homemade pancakes" },
  { title: "Half Past Somewhere", artist: "lowbeam", genre: "Hip-hop", art: "art-night", symbol: "☾", description: "Lo-fi hip-hop · after the last train" },
  { title: "Peach Static", artist: "monte rosa", genre: "Electronic", art: "art-pink", symbol: "〰", description: "Dream pop · drifting out to sea" },
];

const promptInput = document.querySelector("#song-prompt");
const promptCount = document.querySelector("#prompt-count");
const controlsPanel = document.querySelector("#custom-controls");
const createButton = document.querySelector("#create-button");
const messageArea = document.querySelector("#creation-message");
const toastRegion = document.querySelector("#toast-region");
let chosenVocal = "With vocals";
let libraryFilter = "all";
let walletAddress = null;
let activeVideoJob = null;
let tracks = readTracks();

function readTracks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((track) => track && typeof track.id === "string" && typeof track.title === "string") : [];
  } catch (error) {
    showToast("Couldn't read your saved library. New tracks will still work for this session.", true);
    return [];
  }
}

function persistTracks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
  } catch (error) {
    showToast("This browser couldn't save your library. Your changes are still visible until you leave.", true);
  }
}

function showToast(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " error" : ""}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function updateWalletUi() {
  const name = walletAddress ? formatAddress(walletAddress) : "Your space";
  const subtitle = walletAddress ? "Wallet connected" : "Connect a wallet";
  document.querySelector("#profile-name").textContent = name;
  document.querySelector("#profile-subtitle").textContent = subtitle;
  document.querySelector("#avatar").textContent = walletAddress ? "✳" : "♫";
  document.querySelector("#top-avatar").textContent = walletAddress ? "✳" : "♫";
  document.querySelector("#top-wallet-button").textContent = walletAddress ? "Sign out" : "Connect wallet";
}

async function connectWallet() {
  const provider = window.ethereum;
  if (!provider || typeof provider.request !== "function") {
    showToast("No browser wallet found. Install an EVM wallet extension, then try again.", true);
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new Error("The wallet didn't return an account.");
    }
    walletAddress = accounts[0];
    updateWalletUi();
    showToast(`Wallet connected: ${formatAddress(walletAddress)}.`);
  } catch (error) {
    if (error && error.code === 4001) {
      showToast("Wallet connection was cancelled.");
      return;
    }
    showToast(error instanceof Error ? `Couldn't connect wallet: ${error.message}` : "Couldn't connect wallet.", true);
  }
}

async function restoreWallet() {
  if (!window.ethereum || typeof window.ethereum.request !== "function") return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    walletAddress = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
    updateWalletUi();
  } catch (error) {
    showToast(error instanceof Error ? `Couldn't check wallet connection: ${error.message}` : "Couldn't check wallet connection.", true);
  }
}

function signOut() {
  walletAddress = null;
  updateWalletUi();
  showToast("Signed out of Frostwave. Your connected wallet is unchanged.");
}

function updatePromptCount() {
  promptCount.textContent = String(promptInput.value.length);
}

function renderTrack(track) {
  const favoriteLabel = track.favorite ? "Remove from favorites" : "Add to favorites";
  return `<div class="track-row">
    <div class="track-art ${escapeHtml(track.art || "art-peach")}" aria-hidden="true"><span>${escapeHtml(track.symbol || "♫")}</span></div>
    <div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.description || "New idea · Just now")}</span></div>
    <span class="track-badge">${escapeHtml(track.genre || "New idea")}</span>
    <div class="track-actions"><button class="icon-button" data-action="preview" data-id="${escapeHtml(track.id)}" aria-label="Preview ${escapeHtml(track.title)}">▶</button><button class="icon-button${track.favorite ? " favorite" : ""}" data-action="favorite" data-id="${escapeHtml(track.id)}" aria-label="${favoriteLabel}" title="${favoriteLabel}">${track.favorite ? "♥" : "♡"}</button></div>
  </div>`;
}

function renderLibrary() {
  const visibleTracks = tracks.filter((track) => libraryFilter !== "favorites" || track.favorite);
  document.querySelector("#recent-track-list").innerHTML = tracks.slice(0, 3).map(renderTrack).join("");
  document.querySelector("#library-track-list").innerHTML = visibleTracks.map(renderTrack).join("");
  document.querySelector("#library-total").textContent = `${visibleTracks.length} ${visibleTracks.length === 1 ? "track" : "tracks"}`;
  document.querySelector("#empty-library").hidden = visibleTracks.length !== 0;
  document.querySelector("#library-track-list").hidden = visibleTracks.length === 0;
}

function renderDiscover(filter = "All", query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = discoveries.filter((track) => (filter === "All" || track.genre === filter)
    && `${track.title} ${track.artist} ${track.genre} ${track.description}`.toLowerCase().includes(normalizedQuery));
  document.querySelector("#discover-grid").innerHTML = matches.length
    ? matches.map((track, index) => `<article class="discover-card">
        <div class="card-art ${track.art}" aria-label="${escapeHtml(track.description)}"><span>${track.symbol}</span>
          <button class="play-card" data-action="preview" data-id="community-${index}" aria-label="Preview ${escapeHtml(track.title)}">▶</button>
        </div>
        <div class="card-meta"><div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)} · ${escapeHtml(track.genre)}</span></div>
          <button class="icon-button" data-action="remix" data-title="${escapeHtml(track.title)}" aria-label="Use ${escapeHtml(track.title)} as inspiration" title="Use as inspiration">↗</button>
        </div>
      </article>`).join("")
    : '<div class="no-results">No tracks found. Try another search or genre.</div>';
}

function switchView(name) {
  const titles = { create: "Create", video: "AI video", discover: "Discover", library: "Your library" };
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-view`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
  document.querySelector("#breadcrumb-label").textContent = titles[name] || titles.create;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelector("#top-wallet-button").addEventListener("click", () => walletAddress ? signOut() : connectWallet());
document.querySelector("#profile-button").addEventListener("click", () => walletAddress ? signOut() : connectWallet());
document.querySelector("#top-avatar").addEventListener("click", () => walletAddress ? signOut() : connectWallet());
promptInput.addEventListener("input", updatePromptCount);

document.querySelector("#custom-mode-button").addEventListener("click", (event) => {
  const opening = controlsPanel.hidden;
  controlsPanel.hidden = !opening;
  event.currentTarget.setAttribute("aria-expanded", String(opening));
});

document.querySelector("#idea-button").addEventListener("click", () => {
  const current = promptInput.value;
  const options = ideas.filter((idea) => idea !== current);
  promptInput.value = options[Math.floor(Math.random() * options.length)];
  updatePromptCount();
  promptInput.focus();
});

document.querySelectorAll("[data-vocal]").forEach((button) => {
  button.addEventListener("click", () => {
    chosenVocal = button.dataset.vocal;
    document.querySelectorAll("[data-vocal]").forEach((option) => option.classList.toggle("selected", option === button));
  });
});

for (const [inputId, valueId] of [["warmth-range", "warmth-value"], ["style-range", "style-value"]]) {
  const range = document.getElementById(inputId);
  range.addEventListener("input", () => { document.getElementById(valueId).textContent = range.value; });
}

createButton.addEventListener("click", () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    messageArea.textContent = "Add a few words about your song first.";
    promptInput.focus();
    return;
  }
  const customTitle = document.querySelector("#song-title").value.trim();
  const genre = document.querySelector("#genre-select").value;
  const mood = document.querySelector("#mood-select").value;
  const lyrics = document.querySelector("#lyrics-input").value.trim();
  const title = customTitle || prompt.split(/[.!?]/)[0].split(/\s+/).slice(0, 5).join(" ");
  createButton.disabled = true;
  createButton.querySelector("span:first-child").textContent = "Saving your idea…";
  messageArea.textContent = "";
  window.setTimeout(() => {
    const track = {
      id: `local-${Date.now()}`,
      title: title || "A new idea",
      description: `${genre === "Surprise me" ? mood : genre} · ${chosenVocal === "Instrumental" ? "Instrumental" : "Song idea"}${lyrics ? " · Your lyrics" : ""}`,
      genre: genre === "Surprise me" ? "New idea" : genre,
      prompt,
      art: ["art-peach", "art-blue", "art-lilac", "art-green", "art-pink"][tracks.length % 5],
      symbol: ["♫", "✳", "☼", "◌", "〰"][tracks.length % 5],
      favorite: false,
      createdAt: new Date().toISOString(),
    };
    tracks.unshift(track);
    persistTracks();
    renderLibrary();
    createButton.disabled = false;
    createButton.querySelector("span:first-child").textContent = "Make my song";
    messageArea.textContent = "Your idea is in your library. Audio generation needs a music-generation service, which isn't connected yet.";
    document.querySelector("#recently-made").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 450);
});

document.querySelectorAll(".filter-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderDiscover(button.dataset.filter, document.querySelector("#discover-search").value);
  });
});

document.querySelector("#discover-search").addEventListener("input", (event) => {
  const selectedFilter = document.querySelector(".filter-tab.active")?.dataset.filter || "All";
  renderDiscover(selectedFilter, event.currentTarget.value);
});

const videoPrompt = document.querySelector("#video-prompt");
const videoButton = document.querySelector("#create-video-button");
const videoStatus = document.querySelector("#video-status");
const videoProgress = document.querySelector("#video-progress");
const videoOutput = document.querySelector("#video-output");

async function readApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Local video service returned ${response.status}.`);
  }
  return data;
}

async function checkVideoEngine() {
  try {
    const response = await fetch("/api/video/health");
    const health = await readApiResponse(response);
    videoStatus.textContent = health.ready
      ? `Local GPU ready${health.gpu ? ` · ${health.gpu}` : ""}. No app generation cap.`
      : health.message;
  } catch (error) {
    videoStatus.textContent = "Local engine not running. Start it with `python server.py`.";
  }
}

async function pollVideoJob(jobId) {
  try {
    const response = await fetch(`/api/video/jobs/${encodeURIComponent(jobId)}`);
    const job = await readApiResponse(response);
    videoProgress.hidden = false;
    document.querySelector("#video-progress-bar").max = job.total_clips || 60;
    document.querySelector("#video-progress-bar").value = job.progress || 0;
    document.querySelector("#video-progress-count").textContent = `${job.completed_clips || 0} / ${job.total_clips || 60} clips`;
    document.querySelector("#video-progress-message").textContent = job.message;
    document.querySelector("#video-progress-title").textContent = job.status === "queued" ? "Waiting for your turn" : "Making your video";

    if (job.status === "complete") {
      videoStatus.textContent = "Your five-minute video is ready.";
      videoOutput.hidden = false;
      const videoUrl = `${job.video_url}?t=${Date.now()}`;
      document.querySelector("#generated-video").src = videoUrl;
      document.querySelector("#download-video").href = job.video_url;
      videoButton.disabled = false;
      videoButton.querySelector("span:first-child").textContent = "Create another video";
      activeVideoJob = null;
      return;
    }
    if (job.status === "failed") {
      videoStatus.textContent = `Video generation failed: ${job.message}`;
      videoButton.disabled = false;
      videoButton.querySelector("span:first-child").textContent = "Try again";
      activeVideoJob = null;
      showToast(job.message, true);
      return;
    }
    videoStatus.textContent = job.status === "queued" ? "Your video is queued on the local GPU." : "Your local GPU is rendering the video.";
    window.setTimeout(() => pollVideoJob(jobId), 5000);
  } catch (error) {
    videoStatus.textContent = `Couldn't check video progress: ${error.message}`;
    videoButton.disabled = false;
    videoButton.querySelector("span:first-child").textContent = "Try again";
    activeVideoJob = null;
    showToast(error.message, true);
  }
}

videoPrompt.addEventListener("input", () => {
  document.querySelector("#video-prompt-count").textContent = String(videoPrompt.value.length);
});

videoButton.addEventListener("click", async () => {
  if (!videoPrompt.value.trim()) {
    videoStatus.textContent = "Describe the video you want to make first.";
    videoPrompt.focus();
    return;
  }
  videoButton.disabled = true;
  videoButton.querySelector("span:first-child").textContent = "Sending to local GPU…";
  videoStatus.textContent = "Submitting your prompt to the local video engine…";
  videoOutput.hidden = true;
  videoProgress.hidden = true;
  try {
    const response = await fetch("/api/video/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: videoPrompt.value.trim(),
        model: document.querySelector("#video-model").value,
        format: document.querySelector("#video-format").value,
        style: document.querySelector("#video-look").value,
      }),
    });
    const job = await readApiResponse(response);
    activeVideoJob = job.id;
    videoButton.querySelector("span:first-child").textContent = "Rendering…";
    pollVideoJob(job.id);
  } catch (error) {
    videoStatus.textContent = error.message;
    videoButton.disabled = false;
    videoButton.querySelector("span:first-child").textContent = "Try again";
    showToast(error.message, true);
  }
});

document.querySelectorAll(".library-tab").forEach((button) => {
  button.addEventListener("click", () => {
    libraryFilter = button.dataset.libraryFilter;
    document.querySelectorAll(".library-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderLibrary();
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "favorite") {
    const track = tracks.find((item) => item.id === id);
    if (!track) return;
    track.favorite = !track.favorite;
    persistTracks();
    renderLibrary();
  } else if (action === "preview" && id.startsWith("community-")) {
    showToast("Community audio previews will be available when an audio catalogue is connected.");
  } else if (action === "preview") {
    showToast("This saved idea is a text-only prototype; audio generation isn't connected yet.");
  } else if (action === "remix") {
    promptInput.value = `A fresh idea inspired by "${button.dataset.title}" — make it your own`;
    updatePromptCount();
    switchView("create");
    promptInput.focus();
  }
});

if (window.ethereum && typeof window.ethereum.on === "function") {
  window.ethereum.on("accountsChanged", (accounts) => {
    walletAddress = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
    updateWalletUi();
    if (!walletAddress) showToast("Wallet disconnected from this app.");
  });
}

renderLibrary();
renderDiscover();
updateWalletUi();
restoreWallet();
checkVideoEngine();
