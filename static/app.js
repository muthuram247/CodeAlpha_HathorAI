(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const config = window.HATHOR_CONFIG || {};
  const LOGIN_AUDIT_URL = "https://script.google.com/macros/s/AKfycbyhxQEOmmP_OpBL77tlIhz1Z_JoXDOMJBiSyBgHM9QCB_BleTFwzmBQThFft3LfwRdG/exec";
  const authView = $("#authView");
  const studioView = $("#studioView");
  const authError = $("#authError");
  const toast = $("#toast");
  const audio = $("#audioElement");

  let client = null;
  let session = null;
  let currentRecord = null;
  let historyRecords = [];
  let chosenDuration = 15;
  let toastTimer = null;
  let loadingMessageTimer = null;
  let audioObjectUrl = null;
  let availableGenres = [];

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function showToast(message, type = "info") {
    toast.textContent = message;
    toast.className = `toast show ${type === "error" ? "error" : ""}`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.className = "toast"; }, 4200);
  }

  function showAuthError(message) {
    authError.textContent = message;
    authError.hidden = false;
  }

  function clearAuthError() {
    authError.textContent = "";
    authError.hidden = true;
  }

  function displaySession(nextSession) {
    session = nextSession;
    const signedIn = Boolean(session && session.user);
    authView.hidden = signedIn;
    studioView.hidden = !signedIn;
    if (!signedIn) {
      currentRecord = null;
      historyRecords = [];
      return;
    }
    const user = session.user;
    const email = user.email;
    const label = email ? (email.split("@")[0] || "Composer") : "Guest composer";
    $("#userLabel").textContent = label.length > 18 ? `${label.slice(0, 16)}…` : label;
    if (user.is_anonymous || user.app_metadata?.provider === "anonymous") {
      $("#userLabel").title = "Guest session — its history may not be recoverable after sign-out or browser-data clearing.";
    } else {
      $("#userLabel").title = email || "Signed in with Google";
    }
    refreshHistory({ quiet: true });
  }
  
function auditStorageKey(userId) {
  return `hathor_audit_session_${userId}`;
}

function createAuditSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return "hathor-" + Date.now() + "-" +
    Math.random().toString(36).slice(2);
}

async function sendLoginAudit(action, auditSessionId, activeSession) {
  if (!LOGIN_AUDIT_URL ||
      LOGIN_AUDIT_URL.includes("PASTE_YOUR_APPS_SCRIPT")) {
    console.warn("Hathor login audit URL is not configured.");
    return false;
  }

  if (!auditSessionId || !activeSession?.access_token) {
    return false;
  }

  try {
    // text/plain avoids a browser CORS preflight for this Apps Script POST.
    // Apps Script verifies the access token directly with Supabase.
    await fetch(LOGIN_AUDIT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify({
        action,
        session_id: auditSessionId,
        access_token: activeSession.access_token
      })
    });

    // With no-cors, the response is opaque. This confirms only that
    // fetch completed, not that Apps Script successfully wrote the row.
    return true;
  } catch (error) {
    console.error("Could not send Hathor login audit event:", error);
    return false;
  }
}

async function ensureLoginAudit(activeSession) {
  const user = activeSession?.user;
  if (!user?.id) return;

  const key = auditStorageKey(user.id);
  let auditSessionId = localStorage.getItem(key);

  if (!auditSessionId) {
    auditSessionId = createAuditSessionId();
    localStorage.setItem(key, auditSessionId);
    await sendLoginAudit("login", auditSessionId, activeSession);
  }
}
  async function signInWithGoogle() {
    if (!client) return showAuthError("Supabase configuration is not loaded. Check static/config.js.");
    clearAuthError();
    $("#googleLogin").disabled = true;
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin }
      });
      if (error) throw error;
    } catch (error) {
      showAuthError(error.message || "Google sign-in could not start.");
      $("#googleLogin").disabled = false;
    }
  }

  async function signInAsGuest() {
    if (!client) return showAuthError("Supabase configuration is not loaded. Check static/config.js.");
    clearAuthError();
    const button = $("#guestLogin");
    button.disabled = true;
    try {
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      if (data?.session) displaySession(data.session);
    } catch (error) {
      showAuthError(error.message || "Guest sign-in failed. Enable Anonymous Sign-ins in Supabase Authentication settings.");
    } finally {
      button.disabled = false;
    }
  }

async function logOut() {
  if (!client) return;

  const activeSession = session;
  const userId = activeSession?.user?.id;
  const key = userId ? auditStorageKey(userId) : null;
  const auditSessionId = key ? localStorage.getItem(key) : null;

  try {
    // Send the logout event before invalidating the Supabase session.
    if (auditSessionId && activeSession?.access_token) {
      await sendLoginAudit("logout", auditSessionId, activeSession);
    }

    const { error } = await client.auth.signOut();
    if (error) throw error;

    if (key) localStorage.removeItem(key);

    displaySession(null);
    clearAuthError();
    showToast("You have been logged out.");
  } catch (error) {
    showToast(error.message || "Could not log out.", "error");
  }
}
  
  async function apiRequest(url, options = {}) {
    if (!session?.access_token) throw new Error("Your session has expired. Please sign in again.");
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
        ...(options.headers || {})
      }
    });
    let body = {};
    try { body = await response.json(); } catch (_) { /* use generic error below */ }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function selectedInstruments() {
    return $$("input[name='instrument']:checked").map((input) => input.value);
  }

  function updateInstrumentCount() {
    const selected = selectedInstruments();
    $("#instrumentSelected").textContent = `${selected.length} SELECTED`;
    $$(".instrument-chip").forEach((chip) => {
      const input = chip.querySelector("input");
      chip.classList.toggle("selected", input.checked);
    });
  }

  function updateRangeLabels() {
    $("#tempoValue").textContent = $("#tempo").value;
    $("#energyValue").textContent = $("#energy").value;
    $("#complexityValue").textContent = $("#complexity").value;
    $("#notesCount").textContent = `${$("#creativeNotes").value.length} / 240`;
  }

  function currentOptions() {
    return {
      genre: $("#genre").value,
      mood: $("#mood").value,
      instruments: selectedInstruments(),
      notes: $("#creativeNotes").value.trim(),
      tempo: Number($("#tempo").value),
      energy: Number($("#energy").value),
      complexity: Number($("#complexity").value),
      duration_seconds: chosenDuration
    };
  }

  function setBusy(busy) {
    $("#generateButton").disabled = busy;
    $("#generateButton").querySelector("b").textContent = busy ? "Generating your composition…" : "Generate composition";
    $("#outputStatus").classList.toggle("active", busy);
    $("#outputStatus").innerHTML = busy ? "<i></i> COMPOSING" : (currentRecord ? "<i></i> READY" : "<i></i> IDLE");
    $("#emptyListening").hidden = busy || Boolean(currentRecord);
    $("#loadingPanel").hidden = !busy;
    $("#playerPanel").hidden = busy || !currentRecord;
    $("#outputError").hidden = true;
  }

  function showOutputError(message) {
    const box = $("#outputError");
    box.textContent = message;
    box.hidden = false;
    $("#outputStatus").classList.remove("active");
    $("#outputStatus").innerHTML = "<i></i> CHECK SETUP";
    $("#loadingPanel").hidden = true;
    if (!currentRecord) $("#emptyListening").hidden = false;
    showToast(message, "error");
  }

  async function startGeneration() {
    const options = currentOptions();
    if (options.instruments.length < 1) return showToast("Choose at least one instrument.", "error");
    if (options.instruments.length > 4) return showToast("Choose up to four instruments for one composition.", "error");
    setBusy(true);
    const stages = [
      "Preparing a seed from the trained MIDI patterns…",
      "Sampling new notes with Hathor's LSTM…",
      "Rendering your instrument sounds…",
      "Saving your private listening copy…"
    ];
    let stage = 0;
    $("#loadingMessage").textContent = stages[0];
    loadingMessageTimer = window.setInterval(() => {
      stage = Math.min(stage + 1, stages.length - 1);
      $("#loadingMessage").textContent = stages[stage];
    }, 5000);
    try {
      const result = await apiRequest("/api/generate", { method: "POST", body: JSON.stringify(options) });
      const complete = result.record;
      if (!complete || !complete.audio_url || !complete.audio_path) {
        throw new Error("Hathor did not return a playable saved composition. Check the Render and Supabase logs.");
      }
      currentRecord = complete;
      historyRecords = [complete, ...historyRecords.filter((item) => item.id !== complete.id)].slice(0, 30);
      setBusy(false);
      setActiveRecord(complete, complete.audio_url, false);
      renderHistory();
      showToast("Your custom LSTM composition is ready.");
      refreshHistory({ quiet: true });
    } catch (error) {
      setBusy(false);
      showOutputError(error.message || "Something went wrong while generating the track.");
    } finally {
      window.clearInterval(loadingMessageTimer);
      loadingMessageTimer = null;
      $("#generateButton").disabled = false;
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  function setActiveRecord(record, audioUrl, autoplay = false) {
    if (!record) return;
    currentRecord = { ...record, audio_url: audioUrl || record.audio_url };
    $("#emptyListening").hidden = true;
    $("#loadingPanel").hidden = true;
    $("#playerPanel").hidden = false;
    $("#outputError").hidden = true;
    $("#outputStatus").classList.add("active");
    $("#outputStatus").innerHTML = "<i></i> READY";
    $("#trackTitle").textContent = record.title || "Untitled composition";
    const instruments = Array.isArray(record.instruments) ? record.instruments : [];
    $("#trackSubline").textContent = [record.genre, record.mood, instruments.join(" + ")].filter(Boolean).join(" · ");
    const chips = [record.duration_seconds ? `${record.duration_seconds} SEC` : null, record.tempo ? `${record.tempo} BPM` : null, ...(instruments.slice(0, 4))].filter(Boolean);
    $("#trackChips").innerHTML = chips.map((item) => `<span>${escapeHtml(String(item))}</span>`).join("");
    const source = audioUrl || record.audio_url;
    if (source && audio.src !== source) {
      audio.pause();
      audio.src = source;
      audio.load();
    }
    audio.volume = Number($("#volume").value) / 100;
    audio.playbackRate = Number($("#playbackSpeed").value);
    if ("preservesPitch" in audio) audio.preservesPitch = true;
    if (autoplay && source) {
      audio.play().then(updatePlaybackUi).catch(() => showToast("Tap play to start audio playback on this device."));
    }
    $("#playState").textContent = "READY TO PLAY";
    $("#currentTime").textContent = "0:00";
    $("#progressBar").value = 0;
    if (record.audio_path && !historyRecords.some((item) => item.id === record.id)) {
      historyRecords.unshift(record);
      historyRecords = historyRecords.slice(0, 30);
      renderHistory();
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  async function getSignedUrls(paths) {
    if (!paths.length) return {};
    try {
      const result = await apiRequest("/api/audio-urls", { method: "POST", body: JSON.stringify({ paths }) });
      return result.urls || {};
    } catch (error) {
      console.warn("Could not renew private audio links:", error.message);
      return {};
    }
  }

  async function refreshHistory({ quiet = false } = {}) {
    if (!client || !session?.user) return;
    const list = $("#historyList");
    if (!quiet) list.innerHTML = `<div class="history-empty"><span>◌</span><p>Refreshing your private library…</p></div>`;
    try {
      const { data, error } = await client
        .from("generations")
        .select("id,title,prompt,genre,mood,instruments,duration_seconds,tempo,audio_path,created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      const rows = data || [];
      const urls = await getSignedUrls(rows.map((row) => row.audio_path).filter(Boolean));
      historyRecords = rows.map((row) => ({ ...row, audio_url: urls[row.audio_path] || "" }));
      renderHistory();
    } catch (error) {
      console.warn("History could not be loaded:", error.message);
      if (!quiet) showToast("Could not load history. Check the generations table and its RLS policy.", "error");
      if (!historyRecords.length) {
        list.innerHTML = `<div class="history-empty"><span>◷</span><p>Your library could not be loaded.</p><small>Check the database setup.</small></div>`;
      }
    }
  }

  function timeAgo(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "SAVED TRACK";
    const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return "JUST NOW";
    if (minutes < 60) return `${minutes} MIN AGO`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} HR AGO`;
    const days = Math.floor(hours / 24);
    return `${days} DAY${days === 1 ? "" : "S"} AGO`;
  }

  function renderHistory() {
    const list = $("#historyList");
    const rows = historyRecords.slice(0, 30);
    $("#historyCount").textContent = String(rows.length);
    $("#historyHeadingCount").textContent = `(${rows.length})`;
    if (!rows.length) {
      list.innerHTML = `<div class="history-empty"><span>◷</span><p>Your generated music will live here.</p><small>Every new take, saved in one place.</small></div>`;
      return;
    }
    list.innerHTML = rows.map((record) => {
      const title = escapeHtml(record.title || "Untitled composition");
      const sub = escapeHtml([record.genre, record.mood, timeAgo(record.created_at)].filter(Boolean).join(" · "));
      const unavailable = !record.audio_url;
      return `<article class="history-item" data-record-id="${escapeHtml(String(record.id || ""))}">
        <button class="history-play" type="button" data-action="play" aria-label="Play ${title}" ${unavailable ? "disabled" : ""}>▶</button>
        <div class="history-meta"><b title="${title}">${title}</b><small>${sub}</small></div>
        <div class="history-actions"><button type="button" data-action="download" aria-label="Download ${title}" ${unavailable ? "disabled" : ""}>↓</button></div>
      </article>`;
    }).join("");
  }

  async function downloadRecord(record) {
    if (!record?.audio_path) return showToast("This track has no saved audio file.", "error");
    let url = record.audio_url;
    if (!url) {
      const refreshed = await getSignedUrls([record.audio_path]);
      url = refreshed[record.audio_path];
    }
    if (!url) return showToast("Could not create a download link. Refresh your library and try again.", "error");
    const safeTitle = (record.title || "hathor-composition").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "hathor-composition";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Audio download failed.");
      const blob = await response.blob();
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = audioObjectUrl;
      anchor.download = `${safeTitle}.mp3`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      showToast("Your MP3 download has started.");
    } catch (error) {
      // Fallback for browsers that refuse cross-origin blob downloads.
      window.open(url, "_blank", "noopener");
      showToast("Opened the private audio link. Use the browser menu to download if needed.");
    }
  }

  function updatePlaybackUi() {
    const playing = !audio.paused && !audio.ended;
    $("#playIcon").hidden = playing;
    $("#pauseIcon").hidden = !playing;
    $("#playPause").setAttribute("aria-label", playing ? "Pause audio" : "Play audio");
    $("#playState").textContent = playing ? "NOW PLAYING" : (audio.ended ? "PLAYBACK COMPLETE" : "READY TO PLAY");
  }

  async function togglePlayback() {
    if (!currentRecord || !audio.src) return showToast("Generate or select a saved composition first.");
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
      updatePlaybackUi();
    } catch (_) {
      showToast("Tap play once more to allow audio playback on this device.", "error");
    }
  }

  function usePreset(name) {
    const presets = {
      flute: { genre: "Ambient", mood: "Dreamy", instruments: ["Flute", "Harp"], notes: "A clear, expressive flute lead over delicate harp textures, like morning light over still water.", tempo: 82, energy: 2, complexity: 2, duration: 20 },
      cinema: { genre: "Orchestral", mood: "Epic", instruments: ["Orchestral Strings", "Piano", "Soft Drums"], notes: "A wide cinematic build with a memorable theme, warm strings, restrained percussion and a graceful resolving ending.", tempo: 108, energy: 5, complexity: 4, duration: 30 },
      lofi: { genre: "Lo-fi", mood: "Calm", instruments: ["Piano", "Soft Drums", "Acoustic Guitar"], notes: "Warm, mellow late-night instrumental with soft rhythmic texture and a relaxed, intimate atmosphere.", tempo: 76, energy: 2, complexity: 2, duration: 20 }
    };
    const preset = presets[name];
    if (!preset) return;
    const presetGenreAvailable = !availableGenres.length || availableGenres.some((genre) => normalizeGenreLabel(genre.label) === normalizeGenreLabel(preset.genre));
    $("#genre").value = presetGenreAvailable ? preset.genre : (availableGenres[0]?.label || preset.genre);
    $("#mood").value = preset.mood;
    $("#creativeNotes").value = preset.notes;
    $("#tempo").value = preset.tempo;
    $("#energy").value = preset.energy;
    $("#complexity").value = preset.complexity;
    chosenDuration = preset.duration;
    $$("#durationOptions button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.duration) === chosenDuration));
    $$("input[name='instrument']").forEach((input) => { input.checked = preset.instruments.includes(input.value); });
    updateInstrumentCount();
    updateRangeLabels();
    $("#composerSection").scrollIntoView({ behavior: "smooth", block: "start" });
    showToast(presetGenreAvailable ? "Preset loaded. Adjust anything you like, then generate." : `Preset style is not trained yet; selected ${$("#genre").value}, the available model style.`, presetGenreAvailable ? "info" : "error");
  }

  function normalizeGenreLabel(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  async function loadModelInfo() {
    const note = $("#engineMessage");
    const version = $("#engineVersion");
    try {
      const response = await fetch("/api/model-info", { headers: { "Accept": "application/json" } });
      const info = await response.json();
      if (!response.ok) throw new Error(info.error || "Could not read the model status.");
      const engineReady = Boolean(info.model_ready && info.soundfont_ready);
      $("#generateButton").disabled = !engineReady;
      if (version) version.textContent = engineReady ? "CUSTOM LSTM / MIDI → AUDIO" : (info.model_ready ? "SOUNDFONT MISSING" : "MODEL NOT INSTALLED");
      if (engineReady && Array.isArray(info.genres) && info.genres.length) {
        availableGenres = info.genres;
        const select = $("#genre");
        const oldValue = select.value;
        select.innerHTML = info.genres.map((genre) => `<option value="${escapeHtml(genre.label)}">${escapeHtml(genre.label)}</option>`).join("");
        const matching = info.genres.find((genre) => normalizeGenreLabel(genre.label) === normalizeGenreLabel(oldValue));
        select.value = matching ? matching.label : info.genres[0].label;
        if (note) {
          const styles = info.genres.map((genre) => genre.label).join(", ");
          note.textContent = `Custom LSTM weights loaded. Trained styles: ${styles}. Audio is rendered locally on the server from the model's generated MIDI.`;
        }
      } else if (note) {
        note.textContent = info.model_ready
          ? "The trained LSTM is installed, but the SoundFont renderer is unavailable. Check the Render Docker build and SOUNDFONT_PATH."
          : "Train the LSTM in Google Colab, then upload hathor_lstm_weights.npz to the model/ folder and redeploy Render. Generation stays disabled until your trained weights are installed.";
      }
    } catch (error) {
      $("#generateButton").disabled = true;
      if (version) version.textContent = "MODEL STATUS UNAVAILABLE";
      if (note) note.textContent = "Could not read the custom model status. Check the Render deployment and /api/model-info endpoint.";
      console.warn("Hathor model status:", error.message);
    }
  }

  function bindUi() {
    $("#googleLogin").addEventListener("click", signInWithGoogle);
    $("#guestLogin").addEventListener("click", signInAsGuest);
    $("#logoutButton").addEventListener("click", logOut);
    $("#mobileLogoutButton").addEventListener("click", logOut);
    $("#generateButton").addEventListener("click", startGeneration);
    $("#refreshHistory").addEventListener("click", () => refreshHistory());
    $("#homeBrand").addEventListener("click", (event) => { event.preventDefault(); $("#composerSection").scrollIntoView({ behavior: "smooth" }); });

    $$(".instrument-chip input").forEach((input) => input.addEventListener("change", () => {
      const checked = selectedInstruments();
      if (checked.length > 4) {
        input.checked = false;
        showToast("Choose no more than four instruments for one composition.", "error");
      }
      updateInstrumentCount();
    }));
    ["#tempo", "#energy", "#complexity", "#creativeNotes"].forEach((selector) => $(selector).addEventListener("input", updateRangeLabels));
    $$("#durationOptions button").forEach((button) => button.addEventListener("click", () => {
      chosenDuration = Number(button.dataset.duration);
      $$("#durationOptions button").forEach((item) => item.classList.toggle("selected", item === button));
    }));
    $$(".preset-item").forEach((button) => button.addEventListener("click", () => usePreset(button.dataset.preset)));
    $$(".rail-item[data-scroll]").forEach((button) => button.addEventListener("click", () => {
      const section = document.getElementById(button.dataset.scroll);
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      $$(".rail-item").forEach((item) => item.classList.toggle("active", item === button));
    }));

    $("#playPause").addEventListener("click", togglePlayback);
    $("#downloadButton").addEventListener("click", () => downloadRecord(currentRecord));
    $("#volume").addEventListener("input", () => {
      const volume = Number($("#volume").value);
      audio.volume = volume / 100;
      $("#volumeValue").textContent = `${volume}%`;
    });
    $("#playbackSpeed").addEventListener("input", () => {
      const speed = Number($("#playbackSpeed").value);
      audio.playbackRate = speed;
      if ("preservesPitch" in audio) audio.preservesPitch = true;
      $("#speedValue").textContent = `${speed.toFixed(2)}×`;
    });
    $("#progressBar").addEventListener("input", () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = (Number($("#progressBar").value) / 1000) * audio.duration;
    });
    audio.addEventListener("loadedmetadata", () => { $("#totalTime").textContent = formatTime(audio.duration); });
    audio.addEventListener("timeupdate", () => {
      $("#currentTime").textContent = formatTime(audio.currentTime);
      $("#totalTime").textContent = formatTime(audio.duration);
      if (Number.isFinite(audio.duration) && audio.duration > 0) $("#progressBar").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    });
    audio.addEventListener("play", updatePlaybackUi);
    audio.addEventListener("pause", updatePlaybackUi);
    audio.addEventListener("ended", updatePlaybackUi);
    audio.addEventListener("error", () => {
      if (currentRecord) showToast("This audio link may have expired. Refresh your library to renew it.", "error");
    });

    $("#historyList").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const article = button.closest(".history-item");
      const record = historyRecords.find((item) => String(item.id) === article?.dataset.recordId);
      if (!record) return;
      if (button.dataset.action === "download") return downloadRecord(record);
      if (button.dataset.action === "play") {
        if (!record.audio_url && record.audio_path) {
          const urls = await getSignedUrls([record.audio_path]);
          record.audio_url = urls[record.audio_path] || "";
        }
        if (!record.audio_url) return showToast("Could not load the private audio file. Try refreshing history.", "error");
        setActiveRecord(record, record.audio_url, true);
        $("#playerPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  async function init() {
    bindUi();
    loadModelInfo();
    updateInstrumentCount();
    updateRangeLabels();
    $("#volumeValue").textContent = `${$("#volume").value}%`;
    $("#speedValue").textContent = `${Number($("#playbackSpeed").value).toFixed(2)}×`;
    if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY || !window.supabase?.createClient) {
      showAuthError("Supabase browser configuration is missing. Check static/config.js and the Supabase CDN connection.");
      return;
    }
    client = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    
client.auth.onAuthStateChange((event, nextSession) => {
  window.setTimeout(() => {
    displaySession(nextSession);

    if (event === "SIGNED_IN" && nextSession) {
      ensureLoginAudit(nextSession);
    }
  }, 0);
});
    
    const { data, error } = await client.auth.getSession();
    
if (error) console.warn("Supabase session check:", error.message);

const currentSession = data?.session || null;
displaySession(currentSession);

if (currentSession) {
  ensureLoginAudit(currentSession);
}
    
  document.addEventListener("DOMContentLoaded", init);
})();
