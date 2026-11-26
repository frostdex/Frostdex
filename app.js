const AUTH_STORAGE_KEY = "frostwave-session-v1";
const THEME_STORAGE_KEY = "frostwave-theme-v1";
const API_BASE_URL = String(window.FROSTWAVE_CONFIG?.apiBaseUrl || "").replace(/\/+$/, "");
const VIDEO_JOBS_STORAGE_PREFIX = "frostwave-video-jobs-v1:";
const MUSIC_JOBS_STORAGE_PREFIX = "frostwave-music-jobs-v1:";
const FAVORITES_STORAGE_PREFIX = "frostwave-music-favorites-v1:";
const ideas = [
  "A warm, slow-dancing soul song for a kitchen at midnight",
  "An instrumental soundtrack for getting lost in a new city",
  "A bright indie-pop song about the first day of summer",
  "A hazy lo-fi beat for watching the rain from the window",
  "A playful funk groove about a dog who thinks it's a detective",
];
const promptInput = document.querySelector("#song-prompt");
const promptCount = document.querySelector("#prompt-count");
const controlsPanel = document.querySelector("#custom-controls");
const createButton = document.querySelector("#create-button");
const messageArea = document.querySelector("#creation-message");
const toastRegion = document.querySelector("#toast-region");
const themeToggleButton = document.querySelector("#theme-toggle");
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const audioReferenceInput = document.querySelector("#audio-reference-input");
const audioReferencePreview = document.querySelector("#audio-reference-preview");
const audioReferenceStatus = document.querySelector("#audio-reference-status");
let chosenVocal = "With vocals";
let libraryFilter = "all";
let walletAddress = null;
let walletProvider = null;
let walletProviderPromise = null;
let walletConnectScriptPromise = null;
let activeVideoJob = null;
let activeMusicJob = null;
let hostedMode = false;
let sessionToken = sessionStorage.getItem(AUTH_STORAGE_KEY);
let tracks = [];
let discoveries = [];
let selectedReferenceAudio = null;
let selectedReferenceAudioDuration = null;
let referenceAudioObjectUrl = null;

function updateTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeColorMeta.content = isDark ? "#10110f" : "#f7f5f0";
  themeToggleButton.textContent = isDark ? "☀" : "☾";
  themeToggleButton.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  themeToggleButton.setAttribute("aria-pressed", String(isDark));
  localStorage.setItem(THEME_STORAGE_KEY, isDark ? "dark" : "light");
}

const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
updateTheme(savedTheme === "light" ? "light" : "dark");
themeToggleButton.addEventListener("click", () => {
  updateTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

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
  const subtitle = walletAddress ? "Verified wallet" : "Sign in with a wallet";
  document.querySelector("#profile-name").textContent = name;
  document.querySelector("#profile-subtitle").textContent = subtitle;
  document.querySelector("#avatar").textContent = walletAddress ? "✳" : "♫";
  document.querySelector("#top-avatar").textContent = walletAddress ? "✳" : "♫";
  document.querySelector("#top-wallet-button").textContent = walletAddress ? "Sign out" : "Sign in with wallet";
}

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

function mediaUrl(path) {
  return new URL(path, API_BASE_URL || window.location.origin).toString();
}

function localJobsKey(kind) {
  const address = walletAddress?.toLowerCase();
  if (!address) return null;
  return `${kind === "video" ? VIDEO_JOBS_STORAGE_PREFIX : MUSIC_JOBS_STORAGE_PREFIX}${address}`;
}

function getLocalJobs(kind) {
  const key = localJobsKey(kind);
  if (!key) return [];
  const saved = localStorage.getItem(key);
  if (!saved) return [];
  try {
    const jobs = JSON.parse(saved);
    return Array.isArray(jobs) ? jobs.filter((job) => job && typeof job.id === "string") : [];
  } catch {
    localStorage.removeItem(key);
    showToast("Couldn't read the saved local job list; it has been reset.", true);
    return [];
  }
}

function saveLocalJob(kind, job) {
  const key = localJobsKey(kind);
  if (!key) return;
  const jobs = getLocalJobs(kind).filter((saved) => saved.id !== job.id);
  jobs.unshift(job);
  localStorage.setItem(key, JSON.stringify(jobs.slice(0, 10)));
}

function localFavoriteIds() {
  const address = walletAddress?.toLowerCase();
  if (!address) return [];
  try {
    const favorites = JSON.parse(localStorage.getItem(`${FAVORITES_STORAGE_PREFIX}${address}`) || "[]");
    return Array.isArray(favorites) ? favorites.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  return fetch(apiUrl(path), { ...options, headers }).catch((error) => {
    if (error instanceof TypeError) {
      throw new Error(
        "Couldn't reach the Frostwave API. Check that this Vercel deployment includes the /api functions and is online.",
      );
    }
    throw error;
  });
}

async function getWalletConnectProvider() {
  if (walletProvider) return walletProvider;
  if (walletProviderPromise) return walletProviderPromise;

  const projectId = window.FROSTWAVE_CONFIG?.walletConnectProjectId;
  if (!projectId) {
    throw new Error("WalletConnect isn't configured. Set FROSTWAVE_WALLETCONNECT_PROJECT_ID in Vercel, then redeploy.");
  }

  walletProviderPromise = (async () => {
    if (!window.FrostwaveWalletConnect) {
      if (!walletConnectScriptPromise) {
        walletConnectScriptPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "walletconnect-provider.js";
          script.onload = resolve;
          script.onerror = () => reject(new Error("Couldn't load the WalletConnect provider."));
          document.head.append(script);
        }).catch((error) => {
          walletConnectScriptPromise = null;
          throw error;
        });
      }
      await walletConnectScriptPromise;
    }

    const chains = window.FROSTWAVE_CONFIG.walletConnectChains;
    const EthereumProvider = window.FrostwaveWalletConnect?.EthereumProvider;
    if (!EthereumProvider || !Array.isArray(chains) || chains.length === 0) {
      throw new Error("WalletConnect configuration is invalid. Check the Vercel chain ID settings and redeploy.");
    }
    walletProvider = await EthereumProvider.init({
      projectId,
      optionalChains: chains,
      showQrModal: true,
    });
    walletProvider.on("accountsChanged", (accounts) => {
      if (walletAddress && (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== walletAddress.toLowerCase())) {
        signOut();
        showToast("Wallet account changed. Sign in again to continue.");
      }
    });
    walletProvider.on("disconnect", () => {
      if (walletAddress) {
        signOut();
        showToast("Wallet disconnected. Sign in again to continue.");
      }
    });
    return walletProvider;
  })().finally(() => {
    walletProviderPromise = null;
  });
  return walletProviderPromise;
}

// All configured chains are optional, so the wallet approves whichever it
// supports. Requests sent to a chain outside the approved session fail with
// "Missing or invalid. request() chainId", so sign on a chain the wallet actually
// approved, preferring the one it is currently on.
function approvedWalletAccount(provider) {
  const sessionAccounts = provider.session?.namespaces?.eip155?.accounts;
  if (!Array.isArray(sessionAccounts)) return null;
  const approved = [];
  for (const caipAccount of sessionAccounts) {
    const [namespace, reference, address] = String(caipAccount).split(":");
    const chainId = Number(reference);
    if (namespace === "eip155" && Number.isSafeInteger(chainId) && chainId >= 1 && typeof address === "string" && address) {
      approved.push({ address, chainId });
    }
  }
  const activeChainId = Number(provider.chainId);
  return approved.find((account) => account.chainId === activeChainId) || approved[0] || null;
}

async function connectWallet() {
  try {
    const provider = await getWalletConnectProvider();
    await provider.connect();
    const approved = approvedWalletAccount(provider);
    if (!approved) throw new Error("WalletConnect didn't return an account.");
    const { address, chainId } = approved;
    const challengeResponse = await apiFetch("/api/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, chain_id: chainId }),
    });
    const challenge = await readApiResponse(challengeResponse);
    // provider.request() always targets the provider's own chainId (mainnet by default)
    // and ignores signer.setDefaultChain(), so address the approved chain explicitly.
    const signature = await provider.signer.request(
      { method: "personal_sign", params: [challenge.message, address] },
      `eip155:${chainId}`,
    );
    const verifyResponse = await apiFetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
    });
    const session = await readApiResponse(verifyResponse);
    sessionToken = session.token;
    sessionStorage.setItem(AUTH_STORAGE_KEY, sessionToken);
    walletAddress = session.address;
    updateWalletUi();
    showToast(`Signed in as ${formatAddress(walletAddress)}.`);
    loadVideoJobs();
    loadMusicJobs();
  } catch (error) {
    if (error && error.code === 4001) {
      showToast("Wallet connection was cancelled.");
      return;
    }
    showToast(error instanceof Error ? `Couldn't sign in: ${error.message}` : "Couldn't sign in.", true);
  }
}

async function restoreWallet() {
  if (!sessionToken) {
    updateWalletUi();
    return;
  }
  try {
    const response = await apiFetch("/api/auth/me");
    const session = await readApiResponse(response);
    walletAddress = session.address;
    updateWalletUi();
    await loadVideoJobs();
    await loadMusicJobs();
  } catch (error) {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    sessionToken = null;
    walletAddress = null;
    updateWalletUi();
    showToast(error instanceof Error ? `Your sign-in expired: ${error.message}` : "Your sign-in expired.", true);
  }
}

async function signOut() {
  if (sessionToken) {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (error) {
      showToast(error instanceof Error ? `Local sign-out; server session revocation failed: ${error.message}` : "Local sign-out; server session revocation failed.", true);
    }
  }
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  sessionToken = null;
  walletAddress = null;
  activeVideoJob = null;
  activeMusicJob = null;
  videoButton.disabled = false;
  videoOutput.hidden = true;
  renderVideoJobs([]);
  tracks = [];
  renderLibrary();
  updateWalletUi();
  showToast("Signed out. Your wallet itself is unchanged.");
}

function updatePromptCount() {
  promptCount.textContent = String(promptInput.value.length);
}

function clearAudioReference() {
  if (referenceAudioObjectUrl) URL.revokeObjectURL(referenceAudioObjectUrl);
  referenceAudioObjectUrl = null;
  selectedReferenceAudio = null;
  selectedReferenceAudioDuration = null;
  audioReferenceInput.value = "";
  audioReferencePreview.removeAttribute("src");
  audioReferencePreview.load();
  document.querySelector("#audio-reference-selected").hidden = true;
  document.querySelector("#audio-reference-name").textContent = "";
  document.querySelector("#music-duration").disabled = false;
  audioReferenceStatus.textContent = "";
}

function chooseAudioReference(file) {
  if (hostedMode) {
    audioReferenceStatus.textContent = "Hugging Face music generation doesn't support reference audio clips.";
    return;
  }
  const extension = file.name.split(".").pop().toLowerCase();
  if (!["wav", "mp3", "flac", "ogg"].includes(extension)) {
    clearAudioReference();
    audioReferenceStatus.textContent = "Choose a WAV, MP3, FLAC, or OGG audio file.";
    return;
  }
  if (file.size === 0 || file.size > 32 * 1024 * 1024) {
    clearAudioReference();
    audioReferenceStatus.textContent = "Audio files must be between 1 byte and 32 MB.";
    return;
  }

  if (referenceAudioObjectUrl) URL.revokeObjectURL(referenceAudioObjectUrl);
  selectedReferenceAudio = file;
  selectedReferenceAudioDuration = null;
  referenceAudioObjectUrl = URL.createObjectURL(file);
  audioReferencePreview.src = referenceAudioObjectUrl;
  document.querySelector("#audio-reference-name").textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  document.querySelector("#audio-reference-selected").hidden = false;
  document.querySelector("#music-duration").disabled = true;
  audioReferenceStatus.textContent = "Checking the audio clip…";
}

audioReferencePreview.addEventListener("loadedmetadata", () => {
  const duration = audioReferencePreview.duration;
  if (!Number.isFinite(duration) || duration < 1 || duration > 240) {
    clearAudioReference();
    audioReferenceStatus.textContent = "Reference audio must be between 1 second and 4 minutes.";
    return;
  }
  selectedReferenceAudioDuration = Math.round(duration);
  audioReferenceStatus.textContent = `Ready · the new track will follow this clip’s ${selectedReferenceAudioDuration}-second length.`;
});

audioReferencePreview.addEventListener("error", () => {
  if (selectedReferenceAudio) {
    clearAudioReference();
    audioReferenceStatus.textContent = "This audio file couldn’t be previewed. Try WAV, MP3, FLAC, or OGG.";
  }
});

document.querySelector("#audio-reference-browse").addEventListener("click", () => audioReferenceInput.click());
audioReferenceInput.addEventListener("change", () => {
  const [file] = audioReferenceInput.files;
  if (file) chooseAudioReference(file);
});
document.querySelector("#audio-reference-remove").addEventListener("click", clearAudioReference);
const audioDropzone = document.querySelector("#audio-reference-browse");
audioDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  audioDropzone.classList.add("is-dragging");
});
audioDropzone.addEventListener("dragleave", () => audioDropzone.classList.remove("is-dragging"));
audioDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  audioDropzone.classList.remove("is-dragging");
  if (hostedMode) return;
  const [file] = event.dataTransfer.files;
  if (file) chooseAudioReference(file);
});

function renderTrack(track) {
  const favoriteLabel = track.favorite ? "Remove from favorites" : "Add to favorites";
  const isComplete = track.status === "complete";
  const genre = track.genre || "New idea";
  const description = `${genre} · ${track.duration ? `${Math.round(track.duration / 60)} min` : track.status === "failed" ? track.message : track.message || "Song idea"}`;
  return `<div class="track-row">
    <div class="track-art art-peach" aria-hidden="true"><span>♫</span></div>
    <div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(description)}</span></div>
    <span class="track-badge">${escapeHtml(track.status || genre)}</span>
    <div class="track-actions"><button class="icon-button" data-action="preview-music" data-id="${escapeHtml(track.id)}" aria-label="Play ${escapeHtml(track.title)}" ${isComplete ? "" : "disabled"}>▶</button><button class="icon-button${track.favorite ? " favorite" : ""}" data-action="favorite-music" data-id="${escapeHtml(track.id)}" aria-label="${favoriteLabel}" title="${favoriteLabel}">${track.favorite ? "♥" : "♡"}</button></div>
  </div>`;
}

function renderLibrary() {
  const visibleTracks = tracks.filter((track) => libraryFilter !== "favorites" || track.favorite);
  document.querySelector("#recent-track-list").innerHTML = tracks.slice(0, 3).map(renderTrack).join("")
    || '<div class="video-list-empty">Sign in and make a song to start your library.</div>';
  document.querySelector("#library-track-list").innerHTML = visibleTracks.map(renderTrack).join("");
  document.querySelector("#library-total").textContent = `${visibleTracks.length} ${visibleTracks.length === 1 ? "track" : "tracks"}`;
  document.querySelector("#empty-library").hidden = visibleTracks.length !== 0;
  document.querySelector("#library-track-list").hidden = visibleTracks.length === 0;
}

function renderDiscover(filter = "All", query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = discoveries.filter((track) => (filter === "All" || track.genre === filter)
    && `${track.title} ${track.artist} ${track.genre} ${track.prompt || ""}`.toLowerCase().includes(normalizedQuery));
  document.querySelector("#discover-grid").innerHTML = matches.length
    ? matches.map((track) => `<article class="discover-card">
        <div class="card-art art-lilac" aria-label="${escapeHtml(track.genre)}"><span>♫</span>
          <button class="play-card" data-action="preview-music" data-id="${escapeHtml(track.id)}" aria-label="Play ${escapeHtml(track.title)}">▶</button>
        </div>
        <div class="card-meta"><div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)} · ${escapeHtml(track.genre)}</span></div>
          <button class="icon-button" data-action="remix" data-title="${escapeHtml(track.title)}" data-genre="${escapeHtml(track.genre)}" aria-label="Use ${escapeHtml(track.title)} as inspiration" title="Use as inspiration">↗</button>
        </div>
      </article>`).join("")
    : `<div class="no-results">${discoveries.length ? "No tracks found. Try another search or genre." : "Community Discover needs shared storage, which isn't enabled in this Vercel setup."}</div>`;
}

function switchView(name) {
  const titles = { create: "Create", video: "AI video", discover: "Discover", library: "Your library" };
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-view`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
  document.querySelector("#breadcrumb-label").textContent = titles[name] || titles.create;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    switchView(view);
    if (view === "discover") loadDiscover();
    if (view === "library" && sessionToken) {
      loadMusicJobs();
      loadVideoJobs();
    }
  });
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
    const lyricsInput = document.querySelector("#lyrics-input");
    const lyricsLabel = document.querySelector('label[for="lyrics-input"] .optional');
    lyricsInput.disabled = chosenVocal === "Instrumental";
    lyricsInput.placeholder = chosenVocal === "Instrumental"
      ? "Instrumental songs don't use lyrics."
      : "Write lyrics for vocal songs.";
    lyricsLabel.textContent = chosenVocal === "Instrumental" ? "not used for instrumental" : "required for vocals";
  });
});

for (const [inputId, valueId] of [["warmth-range", "warmth-value"], ["style-range", "style-value"]]) {
  const range = document.getElementById(inputId);
  range.addEventListener("input", () => { document.getElementById(valueId).textContent = range.value; });
}

createButton.addEventListener("click", async () => {
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
  if (chosenVocal === "With vocals" && !lyrics) {
    messageArea.textContent = "Add lyrics for a vocal song, or choose Instrumental.";
    document.querySelector("#lyrics-input").focus();
    return;
  }
  if (selectedReferenceAudio && selectedReferenceAudioDuration === null) {
    messageArea.textContent = "Wait for the audio clip to finish loading, then try again.";
    return;
  }
  if (!sessionToken) {
    showToast("Sign in with your wallet to generate and save music.", true);
    connectWallet();
    return;
  }
  const title = customTitle || prompt.split(/[.!?]/)[0].split(/\s+/).slice(0, 5).join(" ") || "A new idea";
  let uploadedReferenceId = null;
  createButton.disabled = true;
  createButton.querySelector("span:first-child").textContent = selectedReferenceAudio
    ? "Uploading audio…"
    : hostedMode ? "Sending to Hugging Face…" : "Sending to your GPU…";
  messageArea.textContent = "";
  try {
    let generationDuration = selectedReferenceAudioDuration;
    if (selectedReferenceAudio) {
      const uploadResponse = await apiFetch("/api/music/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: selectedReferenceAudio,
      });
      const upload = await readApiResponse(uploadResponse);
      uploadedReferenceId = upload.id;
      generationDuration = upload.duration_seconds;
      createButton.querySelector("span:first-child").textContent = hostedMode ? "Sending to Hugging Face…" : "Sending to your GPU…";
    }
    const response = await apiFetch("/api/music/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        prompt,
        lyrics,
        genre: genre === "Surprise me" ? mood : genre,
        vocal_style: chosenVocal,
        duration: generationDuration ?? Number(document.querySelector("#music-duration").value),
        reference_audio_id: uploadedReferenceId,
        is_public: document.querySelector("#share-song").checked,
      }),
    });
    const job = await readApiResponse(response);
    saveLocalJob("music", job);
    uploadedReferenceId = null;
    activeMusicJob = job.id;
    await loadMusicJobs();
    pollMusicJob(job.id);
    messageArea.textContent = hostedMode
      ? "Your song is queued on Hugging Face ZeroGPU. Free accounts have a limited daily GPU quota; follow progress in Your library."
      : "Your song is queued on your local GPU. You can follow its progress in Your library.";
  } catch (error) {
    messageArea.textContent = error.message;
    showToast(`Couldn't start music generation: ${error.message}`, true);
    if (uploadedReferenceId) {
      try {
        await apiFetch(`/api/music/uploads/${encodeURIComponent(uploadedReferenceId)}`, { method: "DELETE" });
      } catch (cleanupError) {
        showToast(`Couldn't remove the unused audio upload: ${cleanupError.message}`, true);
      }
    }
  } finally {
    createButton.disabled = false;
    createButton.querySelector("span:first-child").textContent = "Make my song";
  }
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

async function loadDiscover() {
  try {
    const response = await apiFetch("/api/discover");
    const data = await readApiResponse(response);
    discoveries = Array.isArray(data.tracks) ? data.tracks : [];
    const selectedFilter = document.querySelector(".filter-tab.active")?.dataset.filter || "All";
    renderDiscover(selectedFilter, document.querySelector("#discover-search").value);
  } catch (error) {
    showToast(`Couldn't load Discover: ${error.message}`, true);
  }
}

const videoPrompt = document.querySelector("#video-prompt");
const videoButton = document.querySelector("#create-video-button");
const videoStatus = document.querySelector("#video-status");
const videoProgress = document.querySelector("#video-progress");
const videoOutput = document.querySelector("#video-output");

function configureGenerationMode() {
  const modelField = document.querySelector("#video-model").closest(".control-field");
  const videoDuration = document.querySelector("#video-duration");
  const audioDropzone = document.querySelector("#audio-reference-browse");
  modelField.hidden = hostedMode;
  videoDuration.firstChild.textContent = hostedMode ? "3.5 seconds " : "5 minutes ";
  videoButton.querySelector("span:first-child").textContent = hostedMode ? "Create 3.5-second clip" : "Create 5-minute video";
  document.querySelector(".video-heading p").textContent = hostedMode
    ? "Describe a moment and create one short video clip with Wan 2.2."
    : "Describe a world, a moment, or a story. Shape a five-minute video from your imagination, rendered on your own GPU.";
  document.querySelector("#video-generation-cost").textContent = hostedMode
    ? "Hugging Face ZeroGPU · free daily quota"
    : "Free · No usage limits";
  document.querySelector(".video-free-note strong").textContent = hostedMode
    ? "Hugging Face ZeroGPU has a limited daily GPU quota."
    : "No service fees or app quotas.";
  document.querySelector(".video-free-note p").textContent = hostedMode
    ? "Each request creates one short clip. The free quota is shared with music generation and may run out for the day."
    : "Choose from five open models. Rendering runs locally on your GPU and uses your electricity and disk space.";
  document.querySelector(".video-backend-note p").textContent = hostedMode
    ? "Wan 2.2 generates one short clip per request through Hugging Face ZeroGPU. Free accounts have a limited daily GPU quota; queue availability depends on Hugging Face."
    : "Five-minute videos are assembled from short generated shots and trimmed to exactly five minutes. Rendering is sequential and can take hours; the selected model's weights download the first time you use it. The local queue has no app-imposed generation cap.";
  document.querySelector("#music-generation-cost").textContent = hostedMode
    ? "Hugging Face ZeroGPU · free daily quota"
    : "Free to create";
  document.querySelector(".free-label .no-limits").textContent = hostedMode
    ? "· Daily GPU quota is limited"
    : "· No credits or paywalls";
  document.querySelector(".free-note div span").textContent = hostedMode
    ? "Free Hugging Face ZeroGPU quota may run out."
    : "Every creative tool is free.";
  document.querySelector(".share-option").hidden = hostedMode;
  document.querySelector("#share-song").checked = false;
  audioDropzone.disabled = hostedMode;
  audioReferenceInput.disabled = hostedMode;
  if (hostedMode) {
    clearAudioReference();
    audioReferenceStatus.textContent = "Reference audio isn't supported by the Hugging Face music Space.";
  } else {
    audioReferenceStatus.textContent = "";
  }
}

async function readApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : `Frostwave API returned ${response.status}.`;
    if (response.status === 404 && (message === "Not found." || message.startsWith("Frostwave API returned"))) {
      throw new Error(`${message} Vercel couldn't find this API function. Redeploy the latest GitHub commit and check the Vercel function logs.`);
    }
    throw new Error(message);
  }
  return data;
}

async function checkVideoEngine() {
  try {
    const response = await apiFetch("/api/video/health");
    const health = await readApiResponse(response);
    hostedMode = health.provider === "huggingface-zerogpu";
    configureGenerationMode();
    videoStatus.textContent = health.ready
      ? hostedMode
        ? "Hugging Face ZeroGPU is configured. Free accounts have a limited daily GPU quota."
        : `Local GPU ready${health.gpu ? ` · ${health.gpu}` : ""}. No app generation cap.`
      : health.message;
  } catch (error) {
    videoStatus.textContent = error instanceof Error ? error.message : "The Frostwave backend couldn't be reached.";
  }
}

async function pollVideoJob(jobId) {
  try {
    const response = await apiFetch(`/api/video/jobs/${encodeURIComponent(jobId)}`);
    const job = await readApiResponse(response);
    const savedJob = getLocalJobs("video").find((saved) => saved.id === jobId);
    saveLocalJob("video", { ...savedJob, ...job });
    videoProgress.hidden = false;
    document.querySelector("#video-progress-bar").max = job.total_clips || 60;
    document.querySelector("#video-progress-bar").value = job.progress || 0;
    const totalClips = job.total_clips || 60;
    document.querySelector("#video-progress-count").textContent = `${job.completed_clips || 0} / ${totalClips} ${totalClips === 1 ? "clip" : "clips"}`;
    document.querySelector("#video-progress-message").textContent = job.message;
    document.querySelector("#video-progress-title").textContent = job.status === "queued" ? "Waiting for your turn" : "Making your video";

    if (job.status === "complete") {
      videoStatus.textContent = hostedMode ? "Your short video is ready." : "Your five-minute video is ready.";
      videoButton.disabled = false;
      videoButton.querySelector("span:first-child").textContent = "Create another video";
      activeVideoJob = null;
      await openVideo(jobId);
      loadVideoJobs();
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
    videoStatus.textContent = job.status === "queued"
      ? hostedMode ? "Your video is queued on Hugging Face ZeroGPU." : "Your video is queued on the local GPU."
      : hostedMode ? "Hugging Face ZeroGPU is rendering your video." : "Your local GPU is rendering the video.";
    window.setTimeout(() => pollVideoJob(jobId), 5000);
  } catch (error) {
    videoStatus.textContent = `Couldn't check video progress: ${error.message}`;
    videoButton.disabled = false;
    videoButton.querySelector("span:first-child").textContent = "Try again";
    activeVideoJob = null;
    showToast(error.message, true);
  }
}

function renderVideoJobs(jobs) {
  const container = document.querySelector("#video-job-list");
  if (!jobs.length) {
    container.innerHTML = '<div class="video-list-empty">Your generated videos will show up here.</div>';
    return;
  }
  container.innerHTML = jobs.map((job) => {
    const isComplete = job.status === "complete";
    const title = job.prompt || job.model;
    const status = isComplete
      ? `Ready · ${job.total_clips === 1 ? "short clip" : "5 minutes"}`
      : `${job.status} · ${job.progress}%`;
    return `<div class="video-job-row">
      <div class="video-job-icon">${isComplete ? "▶" : "◌"}</div>
      <div class="video-job-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(job.model)} · ${escapeHtml(status)}</span></div>
      ${isComplete
        ? `<button class="subtle-link" data-action="open-video" data-id="${escapeHtml(job.id)}">Play / download ↗</button>`
        : `<span class="track-badge">${escapeHtml(job.message)}</span>`}
    </div>`;
  }).join("");
}

async function loadVideoJobs() {
  if (!sessionToken) return;
  try {
    const savedJobs = getLocalJobs("video");
    if (savedJobs.length === 0) {
      renderVideoJobs([]);
      return;
    }
    const ids = savedJobs.map((job) => job.id).join(",");
    const response = await apiFetch(`/api/video/jobs?ids=${encodeURIComponent(ids)}`);
    const data = await readApiResponse(response);
    const remoteJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const jobs = remoteJobs.map((job) => ({
      ...savedJobs.find((saved) => saved.id === job.id),
      ...job,
    }));
    jobs.forEach((job) => saveLocalJob("video", job));
    renderVideoJobs(jobs);
    const activeJob = jobs.find((job) => ["queued", "loading", "rendering", "assembling"].includes(job.status));
    if (activeJob && activeJob.id !== activeVideoJob) {
      activeVideoJob = activeJob.id;
      videoButton.disabled = true;
      videoButton.querySelector("span:first-child").textContent = "Rendering…";
      pollVideoJob(activeJob.id);
    }
  } catch (error) {
    showToast(`Couldn't load your video library: ${error.message}`, true);
  }
}

async function openVideo(jobId) {
  try {
    const ticketResponse = await apiFetch(`/api/video/jobs/${encodeURIComponent(jobId)}/ticket`, { method: "POST" });
    const ticket = await readApiResponse(ticketResponse);
    const videoMediaUrl = mediaUrl(ticket.video_url);
    const video = document.querySelector("#generated-video");
    video.src = videoMediaUrl;
    document.querySelector("#download-video").href = videoMediaUrl;
    document.querySelector("#video-output").hidden = false;
  } catch (error) {
    showToast(`Couldn't open your video: ${error.message}`, true);
  }
}

async function playMusic(jobId) {
  try {
    const response = await apiFetch(`/api/music/jobs/${encodeURIComponent(jobId)}/ticket`, { method: "POST" });
    const ticket = await readApiResponse(response);
    const audioUrl = mediaUrl(ticket.audio_url);
    const player = document.querySelector("#music-player");
    const track = [...tracks, ...discoveries].find((item) => item.id === jobId);
    player.src = audioUrl;
    document.querySelector("#music-player-label").textContent = `Now playing · ${track?.title || "Frostwave song"}`;
    document.querySelector("#music-player-wrap").hidden = false;
    await player.play();
    switchView("create");
  } catch (error) {
    showToast(`Couldn't play this song: ${error.message}`, true);
  }
}

async function loadMusicJobs() {
  if (!sessionToken) {
    tracks = [];
    renderLibrary();
    return;
  }
  try {
    const savedJobs = getLocalJobs("music");
    if (savedJobs.length === 0) {
      tracks = [];
      renderLibrary();
      return;
    }
    const ids = savedJobs.map((job) => job.id).join(",");
    const response = await apiFetch(`/api/music/jobs?ids=${encodeURIComponent(ids)}`);
    const data = await readApiResponse(response);
    const remoteJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const favoriteIds = new Set(localFavoriteIds());
    tracks = remoteJobs.map((job) => ({
      ...savedJobs.find((saved) => saved.id === job.id),
      ...job,
      favorite: favoriteIds.has(job.id),
    }));
    tracks.forEach((track) => saveLocalJob("music", track));
    renderLibrary();
  } catch (error) {
    showToast(`Couldn't load your music library: ${error.message}`, true);
  }
}

async function pollMusicJob(jobId) {
  try {
    const response = await apiFetch(`/api/music/jobs/${encodeURIComponent(jobId)}`);
    const job = await readApiResponse(response);
    const savedJob = getLocalJobs("music").find((saved) => saved.id === jobId);
    saveLocalJob("music", { ...savedJob, ...job });
    if (job.status === "complete") {
      activeMusicJob = null;
      messageArea.textContent = "Your song is ready.";
      await loadMusicJobs();
      await playMusic(jobId);
      loadDiscover();
      return;
    }
    if (job.status === "failed") {
      activeMusicJob = null;
      messageArea.textContent = `Music generation failed: ${job.message}`;
      await loadMusicJobs();
      showToast(job.message, true);
      return;
    }
    messageArea.textContent = job.message;
    window.setTimeout(() => pollMusicJob(jobId), 5000);
  } catch (error) {
    activeMusicJob = null;
    messageArea.textContent = `Couldn't check song progress: ${error.message}`;
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
  videoButton.querySelector("span:first-child").textContent = hostedMode ? "Sending to Hugging Face…" : "Sending to local GPU…";
  videoStatus.textContent = hostedMode
    ? "Submitting one short video request to Hugging Face ZeroGPU…"
    : "Submitting your prompt to the local video engine…";
  videoOutput.hidden = true;
  videoProgress.hidden = true;
  try {
    const response = await apiFetch("/api/video/jobs", {
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
    saveLocalJob("video", job);
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
  if (action === "open-video") {
    openVideo(id);
  } else if (action === "favorite-music") {
    const favorites = new Set(localFavoriteIds());
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    const address = walletAddress?.toLowerCase();
    if (address) localStorage.setItem(`${FAVORITES_STORAGE_PREFIX}${address}`, JSON.stringify([...favorites]));
    tracks = tracks.map((track) => track.id === id ? { ...track, favorite: favorites.has(id) } : track);
    tracks.forEach((track) => saveLocalJob("music", track));
    renderLibrary();
  } else if (action === "preview-music") {
    playMusic(id);
  } else if (action === "remix") {
    promptInput.value = `An original ${button.dataset.genre} song inspired by the feeling of "${button.dataset.title}", with its own melody and story`;
    updatePromptCount();
    switchView("create");
    promptInput.focus();
  }
});

renderLibrary();
renderDiscover();
updateWalletUi();
restoreWallet();
checkVideoEngine();
