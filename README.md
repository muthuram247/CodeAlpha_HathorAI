# Hathor AI

**A custom-trained LSTM music-generation studio.** Turn a musical style, mood, tempo, energy level, arrangement complexity, and instrument choices into a short instrumental composition—then listen, download it, and revisit it in your private library.

<p align="left">
  <a href="https://hathorai.onrender.com/"><strong>Live Demo</strong></a> ·
  <a href="https://github.com/muthuram247/CodeAlpha_HathorAI"><strong>GitHub Repository</strong></a>
</p>

Hathor AI is built around a small LSTM trained from MIDI data in Google Colab. The deployed Flask service runs the exported weights with NumPy, converts the generated note sequence to MIDI, and renders the audio with FluidSynth and a General MIDI SoundFont. It does **not** call a hosted pretrained music-generation API.

## Overview

Hathor AI combines an interactive music studio with authentication, private audio storage, and lightweight session auditing. The interface is designed to work on mobile screens as well as desktop browsers.

### Key features

- **Custom LSTM inference:** generates symbolic note patterns from trained weights exported from the Colab notebook.
- **Music controls:** choose from the genres actually supported by the installed model, select a mood and up to four instruments, and adjust tempo, energy, complexity, and duration.
- **Audio rendering:** turns generated MIDI into MP3 with FluidSynth and a General MIDI SoundFont.
- **Private music library:** saves generated tracks and composition metadata in Supabase, with audio stored in a private Storage bucket.
- **Authentication:** sign in with Google or continue as a guest using Supabase Auth.
- **Playback controls:** play/pause, seek, adjust volume and playback speed, and download MP3 tracks.
- **Login audit spreadsheet:** sends successful sign-in and explicit logout events to Google Sheets through a deployed Google Apps Script endpoint.
- **Health endpoints:** inspect service configuration and confirm whether the model and SoundFont are available.

## Live application

**Website:** <https://hathorai.onrender.com/>

Operational endpoints:

- [`/api/health`](https://hathorai.onrender.com/api/health) — reports service and configuration status.
- [`/api/model-info`](https://hathorai.onrender.com/api/model-info) — reports model readiness, SoundFont readiness, and the trained genres available in the deployed model.

A response from a health endpoint does not guarantee every dependency or user flow is working. Test sign-in, generation, audio playback, and history in the browser after deployment.

## How it works

```mermaid
flowchart TD
    A[User selects music controls] --> B[Browser authenticates with Supabase]
    B --> C[Flask verifies the Supabase access token]
    C --> D[NumPy runs the exported custom LSTM]
    D --> E[Generated piano roll becomes MIDI]
    E --> F[FluidSynth renders MP3 audio]
    F --> G[Flask uploads audio to private Supabase Storage]
    G --> H[Composition metadata saved in Supabase]
    H --> I[Browser receives a signed audio URL]
```

The login audit flow is separate from music generation:

1. Google or guest authentication creates a Supabase session.
2. The browser sends a successful-login event to the configured Google Apps Script web app.
3. Apps Script verifies the Supabase access token before trusting the user identity and writing the event to the spreadsheet.
4. On an explicit logout, the browser sends a logout event so the matching session row can be updated.

## Technology stack

| Component | Technology | Purpose |
|---|---|---|
| Frontend | HTML, CSS, JavaScript | Responsive music studio and audio player |
| Web API | Python, Flask, Gunicorn | Authenticated generation and audio endpoints |
| Music model | Custom LSTM, trained with TensorFlow/Keras in Colab | Predicts symbolic piano-roll patterns |
| Inference | NumPy | Runs exported LSTM weights in the web service |
| MIDI | `pretty_midi` | Creates MIDI arrangements from generated notes |
| Audio rendering | FluidSynth + General MIDI SoundFont | Renders MIDI as MP3 |
| Authentication | Supabase Auth | Google OAuth and anonymous guest sessions |
| Database | Supabase Postgres | Per-user music-generation history |
| File storage | Supabase Storage | Private MP3 files and signed playback URLs |
| Login audit | Google Sheets + Google Apps Script | Records sign-in and explicit logout events |
| Hosting | Render Docker service | Hosts the Flask app and audio-rendering dependencies |

## Repository structure

```text
CodeAlpha_HathorAI/
├── app.py                         # Flask API, LSTM inference, MIDI/MP3 rendering
├── Dockerfile                     # Python, FluidSynth, SoundFont and FFmpeg setup
├── requirements.txt               # Python dependencies
├── supabase_setup.sql             # Music-history table, row security and private bucket
├── HathorAI_Colab_Training.ipynb  # Train and export the custom LSTM in Google Colab
├── model/
│   └── hathor_lstm_weights.npz     # Exported weights (must be supplied after training)
└── static/
    ├── index.html                 # Studio UI and login screen
    ├── styles.css                 # Responsive cyberpunk-inspired styling
    ├── app.js                     # Authentication, login audit, generation and playback
    └── config.js                  # Browser-safe Supabase URL and publishable key
```

The model weights are a generated artifact. If `model/hathor_lstm_weights.npz` is not included in a fresh checkout, train the model and add the exported file before expecting generation to work. Do not put private API keys or OAuth client secrets in the repository.

## Music model: what it does and what it does not do

The Colab notebook trains a two-layer LSTM from randomly initialized weights using MIDI note activity. It exports a compact `.npz` file containing the learned arrays, genre metadata, and seed contexts. The deployed Flask service uses NumPy to run this model; TensorFlow is needed for training in Colab, not for normal server inference.

The inference pipeline produces a piano roll (symbolic note activity), creates a MIDI arrangement, and renders that MIDI through a SoundFont. This is different from a model that generates a raw audio waveform.

Current limitations to be aware of:

- **Genre coverage follows the data.** The default MAESTRO MIDI corpus is classical solo piano. The UI should offer only genres that were represented in the training data and exported into the model metadata. To support another style, add appropriately licensed, genre-labelled MIDI data and retrain.
- **Creative text is not semantically interpreted by the LSTM.** It is retained with the composition metadata, while the model is conditioned on trained genre and numeric controls.
- **Instrument patches are approximations.** Selected instruments are rendered through General MIDI SoundFont programs. Some instruments, such as Veena, Bamboo Flute, and Tabla, use the closest available General MIDI patches or percussion substitutes rather than dedicated instrument recordings.
- **Results vary.** Musical quality depends on training data, model parameters, note sampling, arrangement mapping, and the SoundFont. This is an experimental music-generation project, not a guarantee of studio-quality output.

## Run the project

### Prerequisites

- Git and a GitHub account.
- A Supabase project.
- A Google OAuth web client for Google sign-in.
- Google Sheets and Google Apps Script access if using spreadsheet auditing.
- Docker for a local environment that includes FluidSynth and the SoundFont, or a Render account for deployment.
- The trained model artifact: `model/hathor_lstm_weights.npz`.

### 1. Clone the repository

```bash
git clone https://github.com/muthuram247/CodeAlpha_HathorAI.git
cd CodeAlpha_HathorAI
```

### 2. Configure the browser client

Create or update `static/config.js` with the Supabase project URL and the browser-safe publishable key:

```javascript
window.HATHOR_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_SUPABASE_PUBLISHABLE_KEY"
};
```

The publishable key is designed for browser use, but your database and Storage must still enforce appropriate access rules. Never put the Supabase service-role key, Google OAuth client secret, or other server secret in this file.

### 3. Configure Supabase

1. Open your Supabase project and navigate to **SQL Editor**.
2. Run the complete contents of [`supabase_setup.sql`](supabase_setup.sql).
3. Confirm that `public.generations` exists and row-level security (RLS) is enabled.
4. Confirm the `hathor-audio` Storage bucket exists and is **private**.
5. Under **Authentication → Sign-in providers**, enable Google and anonymous sign-ins.
6. Configure the Google OAuth client ID and client secret in Supabase's Google provider settings. Keep the client secret in Supabase, not in GitHub.
7. In Google Cloud Console, set the authorized redirect URI to the Supabase callback URL:

   ```text
   https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback
   ```

8. In Supabase **Authentication → URL Configuration**, set the website's HTTPS origin as the Site URL and add it to the allowed Redirect URLs. Configure the corresponding web origin in Google Cloud's authorized JavaScript origins where required.

Use the exact project ID and deployed website origin shown in your own Supabase, Google Cloud, and Render settings.

### 4. Train and install the LSTM weights

1. Open `HathorAI_Colab_Training.ipynb` in Google Colab.
2. Select a GPU runtime if one is available and appropriate for your session.
3. Run the notebook cells in order to prepare MIDI data, train the LSTM, generate a sample, and export the artifacts.
4. Download the exported `hathor_lstm_weights.npz` file.
5. Upload it to `model/hathor_lstm_weights.npz` in the repository and commit it, or use a secure artifact deployment process that places the file at the configured model path.
6. Redeploy and check `/api/model-info`. Confirm `model_ready` is `true` and review the supported genre list.

Only use MIDI data whose licence permits your intended training and deployment use. The default MAESTRO dataset has a **CC BY-NC-SA 4.0** licence; do not assume it permits commercial use. Check the terms of any additional dataset individually.

### 5. Deploy on Render

The repository uses a Dockerfile because the service needs native audio-rendering packages as well as Python dependencies.

1. Sign in to [Render](https://render.com/).
2. Create a new **Web Service** and connect this GitHub repository.
3. Select **Docker** as the runtime so the included Dockerfile is used.
4. Add the environment variables below in the Render service settings.
5. Deploy, then inspect the health and model-info endpoints.

| Environment variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | Browser/API publishable key used to verify user sessions |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes for private audio storage | Server-only Supabase service-role key supported by the configured backend |
| `AUDIO_BUCKET` | Optional | Storage bucket name; defaults to `hathor-audio` |
| `SOUNDFONT_PATH` | Optional | SoundFont file path; Dockerfile defaults to `/usr/share/sounds/sf2/FluidR3_GM.sf2` |
| `HATHOR_MODEL_PATH` | Optional | Full model path; defaults to `model/hathor_lstm_weights.npz` within the application directory |
| `LOG_LEVEL` | Optional | Python logging level |
| `PORT` | Supplied by host | Port used by the web service |

**Secret management:** keep the service-role key and any OAuth client secret in the hosting/provider secret settings. Do not commit them to GitHub or paste them into browser JavaScript. If a secret has been exposed, rotate it before continuing.

### 6. Verify the deployment

Open the deployed website and test:

1. Guest sign-in.
2. Google sign-in and redirect back to the website.
3. Model readiness and the available genres.
4. An 8-second composition using a genre listed by `/api/model-info`.
5. Playback, seek, volume, speed, and MP3 download.
6. A page refresh followed by music history loading.
7. Logout, then verify the login audit row is updated if Google Sheets tracking is configured.

## Google Sheets login auditing

The browser integration uses the `LOGIN_AUDIT_URL` constant in `static/app.js` to contact a deployed Google Apps Script web app. The Apps Script endpoint should verify the supplied Supabase access token with Supabase before writing a session event. It should not trust user names, email addresses, login methods, or user IDs supplied by the browser without verification.

The intended spreadsheet records fields such as session ID, login timestamp, available name and email, login method (`Google` or `Guest`), current status, last-seen timestamp, logout timestamp, and Supabase user ID.

To configure this integration for your own deployment:

1. Create a Google Sheet for the login audit log.
2. Deploy an Apps Script web app with a `doPost` handler that verifies the Supabase session before writing records.
3. Store the spreadsheet ID and required Supabase configuration in Apps Script **Script Properties**, not in the sheet or browser code.
4. Set `LOGIN_AUDIT_URL` in `static/app.js` to your own deployed `/exec` URL and redeploy the frontend.
5. Test both Google and Guest sessions, then test explicit logout and confirm it updates the matching row.

The current integration sends successful sign-in and explicit logout events. It does not guarantee a logout event when a user closes the browser, loses connectivity, or has the device shut down. An `Active` row means the last recorded event was a login; it is not proof that the person is currently online. The browser uses a `no-cors` request, so the client cannot read the Apps Script response to confirm that the spreadsheet write succeeded. Check **Apps Script → Executions** if an event is missing.

For a fresh fork, deploy your own Apps Script endpoint and update `LOGIN_AUDIT_URL`; do not rely on another project's endpoint.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Serves the studio UI |
| `GET` | `/api/health` | Reports service and major configuration readiness |
| `GET` | `/api/model-info` | Checks whether model weights can load, SoundFont availability, and supported genres |
| `POST` | `/api/generate` | Authenticates the user, generates notes, renders audio, stores the MP3 and returns the saved record |
| `POST` | `/api/audio-urls` | Returns signed audio URLs for the current user's own stored audio paths |

Protected endpoints expect a Supabase access token in the request header:

```http
Authorization: Bearer YOUR_SUPABASE_ACCESS_TOKEN
```

Do not share access tokens. This example documents the request format only.

## Troubleshooting

| Issue | What to check |
|---|---|
| `model_ready` is `false` | Confirm `model/hathor_lstm_weights.npz` exists at the server model path; inspect `/api/model-info`; retrain/re-export if the file is invalid. |
| No genres are available | Confirm that the training data includes valid genre-labelled MIDI files and the export contains genre metadata and seed contexts. |
| SoundFont missing | Deploy using Docker and confirm `SOUNDFONT_PATH` points to an installed SoundFont file. |
| Sign-in or redirect fails | Check Google provider settings, Supabase callback URI, Site URL, and allowed redirect URLs. Rotate any client secret that may have been exposed. |
| Guest sign-in fails | Enable anonymous sign-ins in Supabase Authentication. |
| Generation returns `401` | Sign in again and confirm the browser sends a valid Supabase access token. |
| Generation returns `429` | The demo rate limit may have been reached, or another composition is in progress. Wait and retry. |
| Generation returns `502` or `503` | Check Supabase/storage configuration, model readiness, SoundFont availability, and Render logs. |
| Track is created but playback fails | Refresh history to request a new signed URL and verify that the MP3 remains in the private Storage bucket. |
| Login audit row is missing | Check `LOGIN_AUDIT_URL`, Apps Script deployment access, Script Properties, Supabase token verification, and Apps Script executions. |
| Guest history is lost after sign-out | Anonymous sessions are not permanent identities. Avoid signing out or clearing browser data if that guest session's history must be retained. |

## Security and privacy

- Supabase Auth is used to verify users before generating audio or issuing signed links.
- Generated MP3s are stored in a private Supabase Storage bucket; playback uses time-limited signed URLs.
- Row-level security limits browser access to a user's own generation history.
- The Supabase publishable key can appear in the browser, but the service-role key must remain server-side.
- Never log or save passwords, OAuth client secrets, service-role keys, access tokens, or refresh tokens in Google Sheets.
- Collect only the login information needed for auditing, restrict spreadsheet access, and explain session tracking in your privacy notice.

## Known limitations

- Render free services can sleep after inactivity and may have limited CPU/RAM; initial requests can be slow.
- The server allows one generation at a time and applies demo rate limits to reduce overload.
- Only styles represented by the trained model are genuinely supported.
- Free-text creative direction is stored with the generation; the current LSTM does not interpret it as natural-language instructions.
- Playback speed changes listening speed in the browser; it does not alter the downloaded MP3 file.
- Explicit logout can be tracked, but unexpected browser closure cannot reliably be detected from the browser alone.
- This is an experimental project. Evaluate sample quality, privacy requirements, dataset licensing, and deployment capacity before presenting it as a commercial production service.

## Dataset and dependency references

- [MAESTRO dataset](https://magenta.tensorflow.org/datasets/maestro)
- [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
- [FluidSynth](https://www.fluidsynth.org/)
- [Supabase Auth documentation](https://supabase.com/docs/guides/auth)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Render Docker deployment](https://render.com/docs/docker)
- [Google Apps Script web apps](https://developers.google.com/apps-script/guides/web)

## License

No top-level project license file is currently included in this repository. Unless a license is added by the project owner, do not assume the project source is licensed for unrestricted reuse. The MAESTRO dataset, SoundFont, and other third-party components have their own terms; review them separately.

---

**Hathor AI — Every feeling has a frequency.**
