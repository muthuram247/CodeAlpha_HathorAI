"""Hathor AI: custom LSTM MIDI generation and SoundFont rendering.

No pretrained music-generation model or external generation API is used.
The Colab notebook trains a Keras LSTM from MIDI rolls and exports its weights
as a compact NPZ artifact. This server performs inference with NumPy and renders
the generated MIDI through FluidSynth.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import numpy as np
import pretty_midi
import requests
from flask import Flask, jsonify, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

ROOT = Path(__file__).resolve().parent
MODEL_PATH = Path(os.getenv("HATHOR_MODEL_PATH", str(ROOT / "model" / "hathor_lstm_weights.npz")))

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
AUDIO_BUCKET = os.getenv("AUDIO_BUCKET", "hathor-audio")
SOUNDFONT_ENV = os.getenv("SOUNDFONT_PATH", "")
MAX_AUDIO_BYTES = 50 * 1024 * 1024
MAX_PROMPT_LENGTH = 240

MODEL_LOCK = threading.RLock()
GENERATION_LOCK = threading.Lock()
RATE_EVENTS: dict[str, list[float]] = {}
RATE_LOCK = threading.Lock()
_MODEL_CACHE: dict | None = None

ALLOWED_GENRES = {
    "Cinematic", "Classical", "Jazz", "Ambient", "Electronic", "Lo-fi",
    "Orchestral", "Acoustic", "Indian Fusion", "Fantasy", "Neo-soul", "World Music",
    "Pop", "Rock", "Folk", "Blues", "Indian Classical",
}
ALLOWED_MOODS = {
    "Dreamy", "Calm", "Epic", "Joyful", "Melancholic", "Mysterious",
    "Romantic", "Peaceful", "Dark", "Hopeful", "Spiritual", "Playful",
}
# General MIDI programs are zero-based. Veena and Bamboo Flute are mapped to
# the nearest standard GM patches; they are not dedicated recordings of those instruments.
INSTRUMENTS: dict[str, tuple[int | None, str]] = {
    "Flute": (73, "melodic"),
    "Bamboo Flute": (75, "melodic"),
    "Piano": (0, "melodic"),
    "Violin": (40, "melodic"),
    "Cello": (42, "melodic"),
    "Harp": (46, "melodic"),
    "Acoustic Guitar": (24, "melodic"),
    "Electric Guitar": (27, "melodic"),
    "Sitar": (104, "melodic"),
    "Veena": (104, "melodic"),
    "Tabla": (None, "tabla_drums"),
    "Saxophone": (65, "melodic"),
    "Trumpet": (56, "melodic"),
    "Synthesizer": (81, "melodic"),
    "Soft Drums": (None, "soft_drums"),
    "Orchestral Strings": (48, "melodic"),
    "Music Box": (10, "melodic"),
    "Oboe": (68, "melodic"),
    "Clarinet": (71, "melodic"),
    "Harmonica": (22, "melodic"),
    "Handpan": (108, "melodic"),
    "Marimba": (12, "melodic"),
}
GENRE_ALIASES = {
    "lo-fi": "lo_fi", "lo fi": "lo_fi", "lofi": "lo_fi",
    "neo-soul": "neo_soul", "indian fusion": "indian_fusion",
    "indian classical": "indian_classical", "world music": "world_music",
}
MOOD_TEMPERATURE = {
    "Dreamy": 0.84, "Calm": 0.76, "Epic": 1.08, "Joyful": 0.98,
    "Melancholic": 0.86, "Mysterious": 1.02, "Romantic": 0.88,
    "Peaceful": 0.74, "Dark": 1.04, "Hopeful": 0.94,
    "Spiritual": 0.82, "Playful": 1.05,
}


def api_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _client_ip() -> str:
    return request.remote_addr or "unknown"


def check_rate_limit(identity: str, limit: int = 8, window_seconds: int = 3600) -> bool:
    now = time.time()
    with RATE_LOCK:
        recent = [stamp for stamp in RATE_EVENTS.get(identity, []) if now - stamp < window_seconds]
        if len(recent) >= limit:
            RATE_EVENTS[identity] = recent
            return False
        recent.append(now)
        RATE_EVENTS[identity] = recent
        return True


def require_user():
    """Verify a Supabase session before generating or signing private audio links."""
    if not (SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY):
        return None, ("Supabase is not configured on the server yet.", 503)
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None, ("Please sign in before generating music.", 401)
    try:
        response = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": auth_header},
            timeout=15,
        )
    except requests.RequestException:
        return None, ("Could not verify your session. Please try again.", 502)
    if response.status_code != 200:
        return None, ("Your session expired. Please sign in again.", 401)
    user = response.json()
    if not user.get("id"):
        return None, ("Could not verify your account.", 401)
    return user, None


def service_headers(extra: dict | None = None) -> dict:
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is missing from Render environment settings.")
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if extra:
        headers.update(extra)
    return headers


def signed_audio_url(path: str) -> str:
    encoded_path = quote(path, safe="/")
    response = requests.post(
        f"{SUPABASE_URL}/storage/v1/object/sign/{AUDIO_BUCKET}/{encoded_path}",
        headers=service_headers({"Content-Type": "application/json"}),
        json={"expiresIn": 60 * 60 * 24},
        timeout=20,
    )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"Could not create a private audio link: {response.text[:200]}")
    signed = response.json().get("signedURL") or response.json().get("signedUrl")
    if not signed:
        raise RuntimeError("Storage returned no signed audio URL.")
    if signed.startswith("https://") or signed.startswith("http://"):
        return signed
    if not signed.startswith("/"):
        signed = "/" + signed
    if signed.startswith("/storage/v1/"):
        return f"{SUPABASE_URL}{signed}"
    return f"{SUPABASE_URL}/storage/v1{signed}"


def store_audio(user_id: str, audio_bytes: bytes, metadata: dict) -> dict:
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        raise RuntimeError("Supabase server-side storage is not configured.")
    if not audio_bytes or len(audio_bytes) > MAX_AUDIO_BYTES:
        raise RuntimeError("The rendered audio is empty or exceeds the 50 MB storage limit.")

    file_name = f"{uuid.uuid4().hex}.mp3"
    storage_path = f"{user_id}/{file_name}"
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{AUDIO_BUCKET}/{quote(storage_path, safe='/')}"
    upload_response = requests.post(
        upload_url,
        headers=service_headers({
            "Content-Type": "audio/mpeg", "x-upsert": "false", "cache-control": "3600"
        }),
        data=audio_bytes,
        timeout=60,
    )
    if upload_response.status_code not in (200, 201):
        raise RuntimeError(f"Audio upload failed: {upload_response.text[:200]}")

    row = {
        "user_id": user_id,
        "title": metadata["title"],
        "prompt": metadata["prompt"],
        "genre": metadata["genre"],
        "mood": metadata["mood"],
        "instruments": metadata["instruments"],
        "duration_seconds": metadata["duration_seconds"],
        "tempo": metadata["tempo"],
        "audio_path": storage_path,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        db_response = requests.post(
            f"{SUPABASE_URL}/rest/v1/generations",
            headers=service_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
            json=row,
            timeout=25,
        )
        if db_response.status_code not in (200, 201):
            raise RuntimeError(f"Could not save music history: {db_response.text[:200]}")
        saved_rows = db_response.json()
        saved = saved_rows[0] if isinstance(saved_rows, list) and saved_rows else row
        saved["audio_url"] = signed_audio_url(storage_path)
        return saved
    except Exception:
        # Remove the private audio file if its history record cannot be saved.
        try:
            requests.delete(upload_url, headers=service_headers(), timeout=15)
        except requests.RequestException:
            pass
        raise


def canonical_genre(value: str) -> str:
    value = value.strip().lower().replace("_", " ")
    return GENRE_ALIASES.get(value, value.replace(" ", "_"))


def display_genre(value: str) -> str:
    special = {"lo_fi": "Lo-fi", "neo_soul": "Neo-soul", "indian_fusion": "Indian Fusion", "indian_classical": "Indian Classical", "world_music": "World Music"}
    return special.get(value, value.replace("_", " ").title())


def find_soundfont() -> str | None:
    candidates = [
        SOUNDFONT_ENV,
        "/usr/share/sounds/sf2/FluidR3_GM.sf2",
        "/usr/share/sounds/sf2/FluidR3_GS.sf2",
        "/usr/share/sounds/sf2/GeneralUser-GS.sf2",
    ]
    for item in candidates:
        if item and Path(item).is_file():
            return item
    return None


def load_model_artifact() -> dict:
    """Load the user-trained NPZ weights once; no framework weights are downloaded."""
    global _MODEL_CACHE
    with MODEL_LOCK:
        if _MODEL_CACHE is not None and _MODEL_CACHE.get("path") == str(MODEL_PATH) and MODEL_PATH.exists():
            return _MODEL_CACHE
        if not MODEL_PATH.is_file():
            raise FileNotFoundError(
                "Your custom LSTM model is not installed. Train the Colab notebook, then upload "
                "hathor_lstm_weights.npz to the repository's model/ folder and redeploy Render."
            )
        with np.load(MODEL_PATH, allow_pickle=False) as data:
            required = [
                "lstm1_kernel", "lstm1_recurrent_kernel", "lstm1_bias",
                "lstm2_kernel", "lstm2_recurrent_kernel", "lstm2_bias",
                "dense_kernel", "dense_bias", "seed_rolls", "seed_genre_indices", "metadata_json",
            ]
            missing = [key for key in required if key not in data]
            if missing:
                raise ValueError(f"The model file is missing required arrays: {', '.join(missing)}")
            arrays = {key: data[key].copy() for key in required if key != "metadata_json"}
            metadata = json.loads(str(data["metadata_json"].item()))
        seq_len = int(metadata["sequence_length"])
        pitch_count = int(metadata["pitch_count"])
        genres = metadata.get("genre_names", [])
        if not genres or arrays["seed_rolls"].ndim != 3:
            raise ValueError("The model artifact has invalid genre metadata or seed contexts.")
        if arrays["seed_rolls"].shape[1:] != (seq_len, pitch_count):
            raise ValueError("Seed contexts do not match the model's sequence dimensions.")
        _MODEL_CACHE = {
            "path": str(MODEL_PATH), "metadata": metadata, "genres": genres, **arrays,
        }
        return _MODEL_CACHE


def sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-values))


def _lstm_step(x: np.ndarray, state: tuple[np.ndarray, np.ndarray], weights: dict, prefix: str) -> tuple[np.ndarray, tuple[np.ndarray, np.ndarray]]:
    h, c = state
    gates = x @ weights[f"{prefix}_kernel"] + h @ weights[f"{prefix}_recurrent_kernel"] + weights[f"{prefix}_bias"]
    units = h.shape[-1]
    i = sigmoid(gates[:units])
    f = sigmoid(gates[units:2 * units])
    candidate = np.tanh(gates[2 * units:3 * units])
    o = sigmoid(gates[3 * units:4 * units])
    c_next = f * c + i * candidate
    h_next = o * np.tanh(c_next)
    return h_next, (h_next, c_next)


def _warm_states(input_sequence: np.ndarray, weights: dict) -> tuple[tuple[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]:
    units1 = weights["lstm1_recurrent_kernel"].shape[0]
    units2 = weights["lstm2_recurrent_kernel"].shape[0]
    state1 = (np.zeros(units1, dtype=np.float32), np.zeros(units1, dtype=np.float32))
    state2 = (np.zeros(units2, dtype=np.float32), np.zeros(units2, dtype=np.float32))
    outputs1 = []
    for x in input_sequence:
        output, state1 = _lstm_step(x, state1, weights, "lstm1")
        outputs1.append(output)
    for output in outputs1:
        _, state2 = _lstm_step(output, state2, weights, "lstm2")
    return state1, state2


def _sample_frame(probabilities: np.ndarray, rng: np.random.Generator, mood: str, energy: int, complexity: int) -> np.ndarray:
    mood_temp = MOOD_TEMPERATURE.get(mood, 0.9)
    temperature = float(np.clip(mood_temp + (complexity - 3) * 0.07 + (energy - 3) * 0.025, 0.55, 1.35))
    p = np.clip(probabilities.astype(np.float64), 1e-5, 1.0 - 1e-5)
    logits = np.log(p / (1.0 - p)) / temperature
    tuned = sigmoid(logits).astype(np.float64)
    # Gumbel noise adds variation while the cap keeps polyphony manageable.
    scores = np.log(np.clip(tuned, 1e-7, 1.0)) - np.log(np.clip(1.0 - tuned, 1e-7, 1.0))
    scores += rng.gumbel(0.0, 0.12, size=scores.shape)
    max_active = max(2, min(8, complexity + 2 + (1 if energy >= 4 else 0)))
    min_probability = 0.16 if energy <= 2 else 0.12
    ranked = np.argsort(scores)[::-1]
    frame = np.zeros(probabilities.shape[0], dtype=np.uint8)
    for idx in ranked:
        if tuned[idx] < min_probability:
            break
        frame[idx] = 1
        if int(frame.sum()) >= max_active:
            break
    if not frame.any() and float(tuned.max()) > 0.075:
        frame[int(np.argmax(tuned))] = 1
    return frame


def generate_piano_roll(model: dict, genre: str, mood: str, duration_seconds: int, tempo: int, energy: int, complexity: int, seed: int | None = None) -> np.ndarray:
    metadata = model["metadata"]
    genre_names = metadata["genre_names"]
    if genre not in genre_names:
        supported = ", ".join(display_genre(g) for g in genre_names)
        raise ValueError(f"This model has not been trained on {display_genre(genre)} MIDI files. Trained styles: {supported}. Add labelled MIDI data and retrain the model in Colab to unlock more styles.")

    genre_index = genre_names.index(genre)
    matching = np.flatnonzero(model["seed_genre_indices"] == genre_index)
    if not len(matching):
        raise ValueError(f"No training seed exists for {display_genre(genre)}. Retrain the model with more MIDI files in that genre folder.")
    rng = np.random.default_rng(seed)
    selected = int(rng.choice(matching))
    context_roll = model["seed_rolls"][selected].astype(np.uint8, copy=True)
    seq_len = int(metadata["sequence_length"])
    pitch_count = int(metadata["pitch_count"])
    genre_vector = np.zeros(len(genre_names), dtype=np.uint8)
    genre_vector[genre_index] = 1
    genre_features = np.broadcast_to(genre_vector, (seq_len, len(genre_names)))
    history: list[np.ndarray] = [frame.copy() for frame in context_roll]

    # Selected tempo scales the frame duration while preserving the requested total duration.
    fps = float(metadata["frames_per_second"])
    frames_to_generate = max(8, int(np.ceil(duration_seconds * fps * tempo / 120.0)))
    state1, state2 = _warm_states(np.concatenate([context_roll, genre_features], axis=1).astype(np.float32), model)
    generated = np.zeros((frames_to_generate, pitch_count), dtype=np.uint8)

    for step in range(frames_to_generate):
        # Reset recurrent states to a rolling training-length context periodically,
        # reducing drift while keeping inference fast enough for a small CPU web service.
        if step and step % seq_len == 0:
            latest = np.asarray(history[-seq_len:], dtype=np.uint8)
            cond = np.broadcast_to(genre_vector, (seq_len, len(genre_names)))
            sequence = np.concatenate([latest, cond], axis=1).astype(np.float32)
            state1, state2 = _warm_states(sequence, model)
        hidden2 = state2[0]
        probabilities = sigmoid(hidden2 @ model["dense_kernel"] + model["dense_bias"])
        frame = _sample_frame(probabilities, rng, mood, energy, complexity)
        generated[step] = frame
        history.append(frame.copy())
        next_input = np.concatenate([frame, genre_vector]).astype(np.float32)
        _, state1 = _lstm_step(next_input, state1, model, "lstm1")
        _, state2 = _lstm_step(state1[0], state2, model, "lstm2")

    # Bridge one-frame holes and suppress isolated one-frame noise for smoother notes.
    smoothed = generated.copy()
    if len(smoothed) > 2:
        for t in range(1, len(smoothed) - 1):
            fill = (smoothed[t - 1] > 0) & (smoothed[t + 1] > 0)
            smoothed[t, fill] = 1
    for pitch in range(pitch_count):
        active = smoothed[:, pitch].astype(bool)
        starts = np.flatnonzero(active & ~np.r_[False, active[:-1]])
        ends = np.flatnonzero(active & ~np.r_[active[1:], False]) + 1
        for start, end in zip(starts, ends):
            if end - start < 2:
                smoothed[start:end, pitch] = 0
    return smoothed


def roll_to_instrument(roll: np.ndarray, name: str, program: int, midi_pitch_shift: int, velocity: int, frame_seconds: float, duration_seconds: float) -> pretty_midi.Instrument:
    instrument = pretty_midi.Instrument(program=program, is_drum=False, name=name)
    pitch_min = 36
    for column in range(roll.shape[1]):
        active = roll[:, column].astype(bool)
        starts = np.flatnonzero(active & ~np.r_[False, active[:-1]])
        ends = np.flatnonzero(active & ~np.r_[active[1:], False]) + 1
        pitch = int(np.clip(pitch_min + column + midi_pitch_shift, 28, 100))
        for start, end in zip(starts, ends):
            start_seconds = float(start * frame_seconds)
            end_seconds = min(float(end * frame_seconds), duration_seconds)
            if end_seconds - start_seconds < 0.10:
                continue
            instrument.notes.append(pretty_midi.Note(
                velocity=int(np.clip(velocity, 1, 120)), pitch=pitch,
                start=start_seconds, end=end_seconds,
            ))
    return instrument


def create_drum_track(name: str, duration: float, tempo: int, energy: int, is_tabla: bool, roll: np.ndarray) -> pretty_midi.Instrument:
    drums = pretty_midi.Instrument(program=0, is_drum=True, name=name)
    beat = 60.0 / tempo
    eighth = beat / 2.0
    total_steps = int(np.ceil(duration / eighth))
    rng = np.random.default_rng()
    for step in range(total_steps):
        start = step * eighth
        if start >= duration:
            break
        roll_frame = min(roll.shape[0] - 1, max(0, int(round(start / (120.0 / tempo / 8.0)))))
        model_activity = int(roll[roll_frame].sum()) if roll.size else 0
        # The LSTM's generated note density modulates percussion activity/velocity.
        if is_tabla:
            # GM conga/bongo-like hand percussion; this is a practical substitute, not a sampled tabla.
            note = [60, 64, 65, 61][step % 4]
            hit_probability = min(0.96, 0.18 + 0.13 * model_activity + (0.12 if step % 2 == 0 else 0.0))
            if rng.random() < hit_probability:
                drums.notes.append(pretty_midi.Note(velocity=int(np.clip(40 + energy * 7 + model_activity * 2, 25, 110)), pitch=note, start=start, end=min(start + 0.09, duration)))
        else:
            if step % 4 == 0 and (model_activity > 0 or rng.random() < 0.18):
                drums.notes.append(pretty_midi.Note(velocity=int(np.clip(48 + energy * 8 + model_activity, 25, 115)), pitch=36, start=start, end=min(start + 0.09, duration)))
            elif step % 4 == 2 and (model_activity > 1 or rng.random() < 0.34):
                drums.notes.append(pretty_midi.Note(velocity=int(np.clip(42 + energy * 7 + model_activity, 25, 110)), pitch=38, start=start, end=min(start + 0.09, duration)))
            if (step % 2 == 1 or energy >= 4) and (model_activity > 0 or rng.random() < 0.42):
                drums.notes.append(pretty_midi.Note(velocity=int(np.clip(28 + energy * 6 + model_activity, 20, 100)), pitch=42, start=start, end=min(start + 0.045, duration)))
    return drums


def make_midi(roll: np.ndarray, instruments: list[str], duration: int, tempo: int, energy: int) -> pretty_midi.PrettyMIDI:
    midi = pretty_midi.PrettyMIDI(initial_tempo=float(tempo), resolution=480)
    frame_seconds = 120.0 / tempo / 8.0
    melodic_items = [(name, INSTRUMENTS[name][0]) for name in instruments if INSTRUMENTS[name][1] == "melodic"]
    for index, (name, program) in enumerate(melodic_items):
        shift = [0, -12, 12, -7][index % 4]
        velocity = int(np.clip(54 + energy * 9 - index * 7, 35, 108))
        midi.instruments.append(roll_to_instrument(roll, name, int(program), shift, velocity, frame_seconds, float(duration)))
    for name in instruments:
        kind = INSTRUMENTS[name][1]
        if kind == "tabla_drums":
            midi.instruments.append(create_drum_track(name, float(duration), tempo, energy, True, roll))
        elif kind == "soft_drums":
            midi.instruments.append(create_drum_track(name, float(duration), tempo, energy, False, roll))
    # When the user picks only percussion, the learned LSTM still determines the
    # number of rhythmic events, but the sound is mapped to standard GM drum notes.
    if not melodic_items and not midi.instruments:
        midi.instruments.append(roll_to_instrument(roll, "Hathor LSTM", 0, 0, 75, frame_seconds, float(duration)))
    return midi


def render_mp3(midi: pretty_midi.PrettyMIDI) -> bytes:
    soundfont = find_soundfont()
    if not soundfont:
        raise RuntimeError("The SoundFont is missing on the server. Check the Render Docker build and FluidSynth installation.")
    if not midi.instruments or not any(inst.notes for inst in midi.instruments):
        raise RuntimeError("The LSTM generated no playable notes this time. Try a different mood or complexity setting.")
    with tempfile.TemporaryDirectory(prefix="hathor-") as temp_dir:
        base = Path(temp_dir)
        midi_path, wav_path, mp3_path = base / "composition.mid", base / "render.wav", base / "composition.mp3"
        midi.write(str(midi_path))
        fluid_cmd = [
            "fluidsynth", "-ni", "-g", "0.8", "-r", "44100", "-L", "2", "-T", "wav", "-O", "s16",
            "-F", str(wav_path), soundfont, str(midi_path),
        ]
        try:
            subprocess.run(fluid_cmd, check=True, capture_output=True, text=True, timeout=100)
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
                "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-codec:a", "libmp3lame",
                "-b:a", "192k", "-ar", "44100", "-ac", "2", str(mp3_path),
            ], check=True, capture_output=True, text=True, timeout=100)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Audio rendering exceeded the server time limit. Try a shorter composition.") from exc
        except subprocess.CalledProcessError as exc:
            logging.error("Audio tool failed: %s", (exc.stderr or "")[-1500:])
            raise RuntimeError("FluidSynth could not render this composition. Check Render deployment logs.") from exc
        if not mp3_path.is_file():
            raise RuntimeError("Audio renderer did not create the MP3 output.")
        return mp3_path.read_bytes()


def build_options(data: dict, model: dict) -> tuple[dict | None, str | None]:
    genre_label = str(data.get("genre", "Classical"))
    if genre_label not in ALLOWED_GENRES:
        return None, "Choose a valid music style."
    genre = canonical_genre(genre_label)
    supported = model["metadata"].get("genre_names", [])
    if genre not in supported:
        trained = ", ".join(display_genre(item) for item in supported)
        return None, f"This model is currently trained on: {trained}. Add MIDI files inside a '{genre}' dataset folder and retrain in Colab to unlock {display_genre(genre)}."

    mood = str(data.get("mood", "Dreamy"))
    if mood not in ALLOWED_MOODS:
        return None, "Choose a valid mood."
    instruments = data.get("instruments", ["Piano"])
    if not isinstance(instruments, list):
        return None, "Instruments must be sent as a list."
    instruments = list(dict.fromkeys(str(item) for item in instruments if str(item) in INSTRUMENTS))[:4]
    if not instruments:
        return None, "Choose at least one valid instrument."
    try:
        duration = int(data.get("duration_seconds", 15))
        tempo = int(data.get("tempo", 100))
        energy = int(data.get("energy", 3))
        complexity = int(data.get("complexity", 3))
    except (TypeError, ValueError):
        return None, "Duration, tempo, energy and complexity must be numbers."
    if duration not in {8, 12, 15, 20, 25, 30}:
        return None, "Choose a supported duration between 8 and 30 seconds."
    if not 40 <= tempo <= 200:
        return None, "Tempo must be between 40 and 200 BPM."
    if not 1 <= energy <= 5 or not 1 <= complexity <= 5:
        return None, "Energy and arrangement complexity must be between 1 and 5."
    notes = str(data.get("notes", "")).strip()
    if len(notes) > MAX_PROMPT_LENGTH:
        return None, f"Additional notes must be {MAX_PROMPT_LENGTH} characters or fewer."
    title = f"{genre_label} · {mood} · {instruments[0]}"
    prompt = (
        f"Custom-trained Hathor LSTM; style={genre_label}; mood={mood}; tempo={tempo} BPM; "
        f"energy={energy}/5; complexity={complexity}/5; instruments={', '.join(instruments)}. "
        f"Creative notes (stored only; not text-interpreted by this LSTM): {notes or 'none'}"
    )
    return {
        "genre": genre_label, "genre_id": genre, "mood": mood, "instruments": instruments,
        "duration_seconds": duration, "tempo": tempo, "energy": energy, "complexity": complexity,
        "notes": notes, "title": title, "prompt": prompt,
    }, None


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/model-info")
def model_info():
    result = {
        "model_ready": MODEL_PATH.is_file(),
        "model_type": "custom LSTM trained from MIDI",
        "model_file": MODEL_PATH.name,
        "soundfont_ready": bool(find_soundfont()),
        "genres": [],
        "message": "Train the Colab notebook and upload model/hathor_lstm_weights.npz before generating music.",
    }
    if MODEL_PATH.is_file():
        try:
            model = load_model_artifact()
            result["genres"] = [{"id": g, "label": display_genre(g)} for g in model["metadata"].get("genre_names", [])]
            result["message"] = "Custom LSTM weights loaded. Output quality depends on the training corpus and sampling settings."
            result["training_files"] = model["metadata"].get("training_file_count")
            result["training_windows"] = model["metadata"].get("training_windows")
        except Exception as exc:
            result["model_ready"] = False
            result["message"] = str(exc)
    return jsonify(result)


@app.get("/api/health")
def health():
    info = model_info().get_json()
    return jsonify({
        "ok": True,
        "service": "Hathor AI",
        "model_type": "custom LSTM from MIDI",
        "model_configured": bool(info.get("model_ready")),
        "supported_genres": [item["label"] for item in info.get("genres", [])],
        "supabase_configured": bool(SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY),
        "storage_configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
        "soundfont_configured": bool(find_soundfont()),
    })


@app.post("/api/generate")
def generate():
    user, err = require_user()
    if err:
        return api_error(*err)
    if not SUPABASE_SERVICE_ROLE_KEY:
        return api_error("Private audio storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY in Render.", 503)
    try:
        model = load_model_artifact()
    except FileNotFoundError as exc:
        return api_error(str(exc), 503)
    except Exception:
        app.logger.exception("Could not load the custom Hathor model")
        return api_error("The custom LSTM artifact could not be loaded. Re-export it from Colab and redeploy.", 503)
    if not find_soundfont():
        return api_error("The audio SoundFont is missing. Check the Render Docker deployment.", 503)
    if not check_rate_limit(f"user:{user['id']}", limit=8):
        return api_error("You have reached the demo limit of 8 generations per hour. Try again later.", 429)
    if not check_rate_limit(f"ip:{_client_ip()}", limit=12):
        return api_error("This connection has reached the demo generation limit. Try again later.", 429)
    if not GENERATION_LOCK.acquire(blocking=False):
        return api_error("Hathor is composing another track on this small server. Please try again in a moment.", 429)
    try:
        data = request.get_json(silent=True) or {}
        options, validation_error = build_options(data, model)
        if validation_error:
            return api_error(validation_error, 400)
        roll = generate_piano_roll(
            model,
            options["genre_id"], options["mood"], options["duration_seconds"],
            options["tempo"], options["energy"], options["complexity"],
        )
        midi = make_midi(roll, options["instruments"], options["duration_seconds"], options["tempo"], options["energy"])
        audio_bytes = render_mp3(midi)
        saved = store_audio(user["id"], audio_bytes, options)
        return jsonify({"status": "succeeded", "record": saved})
    except ValueError as exc:
        return api_error(str(exc), 400)
    except RuntimeError as exc:
        app.logger.warning("Hathor generation failed: %s", str(exc))
        return api_error(str(exc), 503)
    except requests.RequestException:
        app.logger.exception("Supabase request failed while saving generated audio")
        return api_error("The audio was generated, but Supabase did not save it. Check the Supabase settings and logs.", 502)
    except Exception:
        app.logger.exception("Unexpected Hathor generation failure")
        return api_error("Hathor could not finish this composition. Check the Render logs and try a shorter track.", 500)
    finally:
        GENERATION_LOCK.release()


@app.post("/api/audio-urls")
def create_audio_urls():
    user, err = require_user()
    if err:
        return api_error(*err)
    data = request.get_json(silent=True) or {}
    paths = data.get("paths", [])
    if not isinstance(paths, list) or len(paths) > 40:
        return api_error("Send a list of at most 40 audio paths.")
    safe_paths = []
    prefix = f"{user['id']}/"
    for path in paths:
        if isinstance(path, str) and path.startswith(prefix) and ".." not in path.split("/") and path not in safe_paths:
            safe_paths.append(path)
    urls = {}
    for path in safe_paths:
        try:
            urls[path] = signed_audio_url(path)
        except Exception:
            app.logger.exception("Could not sign one history audio URL")
    return jsonify({"urls": urls})


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "The request is too large."}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "10000")), debug=False)
