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
  let activeAuditSessionId = null;
  let activeAuditUserId = null;

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

  function readAuditSessionId(userId) {
    try {
      return window.localStorage.getItem(auditStorageKey(userId));
    } catch (error) {
      console.warn("Local session storage is unavailable; using a temporary audit ID.");
      return null;
    }
  }

  function writeAuditSessionId(userId, value) {
    try {
      window.localStorage.setItem(auditStorageKey(userId), value);
    } catch (error) {
      // Login must keep working even if storage is blocked by the browser.
      console.warn("Could not persist the login audit session ID.");
    }
  }

  function removeAuditSessionId(userId) {
    try {
      window.localStorage.removeItem(auditStorageKey(userId));
    } catch (error) {
      console.warn("Could not remove the login audit session ID.");
    }
  }

  function createAuditSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `hathor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function sendLoginAudit(action, auditSessionId, activeSession) {
    if (!LOGIN_AUDIT_URL || LOGIN_AUDIT_URL.includes("PASTE_YOUR_APPS_SCRIPT")) {
      console.warn("Login tracking is not connected yet. Paste the Apps Script /exec URL into LOGIN_AUDIT_URL.");
      return false;
    }

    if (!auditSessionId || !activeSession?.access_token) return false;

    try {
      // Apps Script accepts a simple text/plain POST, avoiding a CORS preflight.
      // no-cors responses are opaque, so completion does not prove the row was saved.
      await fetch(LOGIN_AUDIT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action,
          session_id: auditSessionId,
          access_token: activeSession.access_token
        })
      });
      return true;
    } catch (error) {
      console.error("Could not send the Hathor login audit event:", error);
      return false;
    }
  }

  async function ensureLoginAudit(activeSession) {
    const userId = activeSession?.user?.id;
    if (!userId) return;

    // Protect against duplicate auth events for the same session.
    if (activeAuditUserId === userId && activeAuditSessionId) return;

    let auditSessionId = readAuditSessionId(userId);
    if (!auditSessionId) {
      auditSessionId = createAuditSessionId();
      writeAuditSessionId(userId, auditSessionId);
      activeAuditUserId = userId;
      activeAuditSessionId = auditSessionId;
      await sendLoginAudit("login", auditSessionId, activeSession);
      return;
    }

    activeAuditUserId = userId;
    activeAuditSessionId = auditSessionId;
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
    const auditSessionId = userId
      ? (activeAuditUserId === userId ? activeAuditSessionId : readAuditSessionId(userId))
      : null;

    try {
      // Send before sign-out invalidates the access token, but don't trap
      // the user on the page if the audit endpoint is slow.
      if (auditSessionId && activeSession?.access_token) {
        await Promise.race([
          sendLoginAudit("logout", auditSessionId, activeSession),
          sleep(1500)
        ]);
      }

      const { error } = await client.auth.signOut();
      if (error) throw error;

      if (userId) removeAuditSessionId(userId);
      activeAuditSessionId = null;
      activeAuditUserId = null;
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

  if (options.instruments.length < 1) {
    return showToast("Choose at least one instrument.", "error");
  }

  if (options.instruments.length > 4) {
    return showToast("Choose up to four instruments.", "error");
  }

  setBusy(true);

  const stages = [
    "Reading your musical direction…",
    "Generating note patterns with the custom LSTM…",
    "Rendering the audio composition…",
    "Saving your private listening copy…"
  ];

  let stage = 0;
  $("#loadingMessage").textContent = stages[0];

  window.clearInterval(loadingMessageTimer);
  loadingMessageTimer = window.setInterval(() => {
    stage = Math.min(stage + 1, stages.length - 1);
    $("#loadingMessage").textContent = stages[stage];
  }, 6500);

  try {
    const result = await apiRequest("/api/generate", {
      method: "POST",
      body: JSON.stringify(options)
    });

    // The custom LSTM backend returns the completed track directly.
    if (result.status !== "succeeded" || !result.record) {
      throw new Error(
        result.error || "The music engine returned an unexpected response."
      );
    }

    const complete = result.record;
    currentRecord = complete;

    historyRecords = [
      complete,
      ...historyRecords.filter(item => item.id !== complete.id)
    ].slice(0, 30);

    setBusy(false);
    setActiveRecord(complete, complete.audio_url, false);
    renderHistory();

    showToast("Your composition is ready in the listening room.");
    refreshHistory({ quiet: true });

  } catch (error) {
    setBusy(false);
    showOutputError(
      error.message || "Something went wrong while generating the track."
    );
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
    $("#genre").value = preset.genre;
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
    showToast("Preset loaded. Adjust anything you like, then generate.");
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

async function initializeModelInfo() {
  const button = $("#generateButton");
  const message = $("#engineMessage");

  button.disabled = true;

  try {
    const response = await fetch("/api/model-info", {
      cache: "no-store"
    });

    let info = {};
    try {
      info = await response.json();
    } catch (_) {}

    if (!response.ok) {
      throw new Error(info.message || "Could not check the music engine.");
    }

    if (!info.model_ready) {
      throw new Error(info.message || "The custom LSTM model is not ready.");
    }

    if (info.soundfont_ready === false) {
      throw new Error("The audio SoundFont is missing on the server.");
    }

    const genres = Array.isArray(info.genres)
      ? info.genres.filter(item => item && item.label)
      : [];

    if (genres.length === 0) {
      throw new Error("No trained music styles were found.");
    }

    // Only display styles the model actually supports.
    const genreSelect = $("#genre");
    const previousGenre = genreSelect.value;

    genreSelect.replaceChildren();

    genres.forEach(item => {
      const option = document.createElement("option");
      option.value = item.label;
      option.textContent = item.label;
      genreSelect.appendChild(option);
    });

    genreSelect.value = genres.some(
      item => item.label === previousGenre
    ) ? previousGenre : genres[0].label;

    message.textContent =
      "Custom LSTM ready. Available styles: " +
      genres.map(item => item.label).join(", ");

    $("#engineVersion").textContent = "MODEL READY";
    button.disabled = false;

  } catch (error) {
    message.textContent = error.message ||
      "Could not initialize the music engine.";

    console.error("Hathor model initialization failed:", error);
    showToast(message.textContent, "error");
  }
}
  
  async function init() {
    bindUi();
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
      // Defer Supabase work until the auth callback has returned.
      window.setTimeout(() => {
        displaySession(nextSession);
        if (event === "SIGNED_IN" && nextSession) {
          ensureLoginAudit(nextSession);
        }
        if (event === "SIGNED_OUT") {
          activeAuditSessionId = null;
          activeAuditUserId = null;
        }
      }, 0);
    });
    const { data, error } = await client.auth.getSession();
    if (error) console.warn("Supabase session check:", error.message);
    const currentSession = data?.session || null;
    displaySession(currentSession);
    await initializeModelInfo();
    if (currentSession) await ensureLoginAudit(currentSession);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
