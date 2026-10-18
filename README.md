# Hathor AI — custom-trained LSTM music generator

**Repository:** `CodeAlpha_HathorAI`  
**Development device:** Android phone + Acode/Termux + GitHub  
**Training:** Google Colab  
**Website/backend:** Render Docker service  
**Authentication, history and private MP3 storage:** Supabase

Hathor AI does **not** call a pretrained music-generation service. You train the model from MIDI in `HathorAI_Colab_Training.ipynb`. The notebook learns a polyphonic LSTM from randomly initialized weights, exports the trained matrices in `hathor_lstm_weights.npz`, and generates a new MIDI note sequence. The Flask app runs that custom model with NumPy and renders its MIDI to MP3 using FluidSynth and a General MIDI SoundFont.

## What is custom and what is not?

- **Custom-trained:** the two-layer LSTM that predicts polyphonic note patterns. The website will not generate music until you train it and install the exported weights.
- **Not a pretrained music model:** the SoundFont is a library of sampled instrument sounds (such as flute, piano and violin) used by FluidSynth to play the MIDI notes. It does not compose music.
- **Initial dataset limitation:** the notebook downloads the MIDI-only MAESTRO corpus, which is classical solo-piano music. By default, your first model therefore supports **Classical**. Add labelled MIDI folders for Jazz, Ambient, Pop, Indian Fusion or other styles and retrain to make those styles available in the UI. The model won't have learned a genre for which you supplied no examples.
- **Text prompt limitation:** this starter's LSTM is conditioned on labelled genre and numeric controls. Mood adjusts sampling, tempo controls timing, energy/complexity adjust note density, and chosen instruments control SoundFont rendering. The free-text creative note is saved with the composition but is not yet interpreted semantically by the model.
- **Quality:** an LSTM trained on MIDI generates symbolic note patterns; it does not learn a raw audio waveform or professional mastering. Result quality depends on dataset coverage, training, sampling and the SoundFont. Test listening results honestly before describing it as studio quality.

## Project files

```text
CodeAlpha_HathorAI/
├── app.py                         # Flask API, custom NumPy LSTM inference, MIDI → MP3
├── requirements.txt               # Small inference-server dependencies; no TensorFlow
├── Dockerfile                     # FluidSynth + SoundFont + FFmpeg for Render
├── supabase_setup.sql             # Private audio bucket, history table and RLS
├── HathorAI_Colab_Training.ipynb  # Train the custom LSTM from scratch in Colab
├── model/
│   └── README.md                  # Where to put your exported model weights
└── static/
    ├── index.html                 # UI
    ├── styles.css                 # Cyberpunk styling
    ├── app.js                     # Auth, generation, player, history
    └── config.js                  # Public Supabase URL + publishable key
```

## Part A — start from your Android phone

1. Download the project ZIP from the conversation and extract it using your file manager, or use Termux:

   ```bash
   pkg update
   pkg install git unzip
   termux-setup-storage
   cd ~/storage/shared/Download
   unzip HathorAI_Project.zip -d ~/HathorAI
   ```

2. Open your existing GitHub repository `CodeAlpha_HathorAI`. Either upload the extracted files using GitHub in your mobile browser or use Termux:

   ```bash
   cd ~
   git clone https://github.com/muthuram247/CodeAlpha_HathorAI.git
   cp -r ~/HathorAI/HathorAI_Project/. ~/CodeAlpha_HathorAI/
   cd ~/CodeAlpha_HathorAI
   git add .
   git commit -m "Build custom LSTM Hathor music generator"
   git push origin main
   ```

   If you already cloned the repository, copy into that existing folder instead of cloning it twice. Adjust the branch name if your default branch is not `main`.

3. `static/config.js` contains only the Supabase project URL and **publishable** key. Those are browser-visible by design. Never put a Google OAuth client secret, Supabase service-role/secret key, or other secret in `static/`, JavaScript, or GitHub.

## Part B — train the LSTM in Google Colab

1. Download `HathorAI_Colab_Training.ipynb` from this repository or the project ZIP.
2. Open [Google Colab](https://colab.research.google.com/) on Android and upload the notebook. Choose a GPU runtime under **Runtime → Change runtime type** if Colab offers one.
3. Run the notebook cells in order. The notebook downloads the MIDI-only MAESTRO dataset, converts it into a polyphonic piano roll, trains a new LSTM from random initialization, generates a sample, and exports the trained weights.
4. To train more than Classical, upload an optional ZIP to `/content/hathor_extra_midi.zip` in Colab **before** running the optional-data cell. The ZIP must use a folder per genre, such as `jazz/song1.mid`, `ambient/song2.mid`, and `indian_fusion/song3.mid`. Use files you created, licensed datasets, or MIDI whose terms permit your intended training use.
5. The final cells download `hathor_lstm_weights.npz`, metadata, and a sample MIDI/MP3 to your Android Downloads folder.

**Dataset licence warning:** the default MAESTRO MIDI corpus is licensed **CC BY-NC-SA 4.0**. Treat a model trained on it as a non-commercial research prototype unless you have confirmed your intended use is permitted. The notebook does not include the dataset itself in this repository. Read the original licence and the licence for every extra MIDI source you use. Sources: <https://magenta.tensorflow.org/datasets/maestro> and <https://creativecommons.org/licenses/by-nc-sa/4.0/>.

## Part C — connect your trained model to GitHub

1. In GitHub mobile, open `CodeAlpha_HathorAI/model/` (create the `model` folder if necessary).
2. Upload the downloaded file with the **exact filename** `hathor_lstm_weights.npz`.
3. Commit the file. It is the model that your notebook trained; it is intentionally not included in the starter ZIP because there is no honestly pre-trained Hathor artifact before you run the notebook.
4. After Render redeploys, open `/api/model-info` on your website. Look for `"model_ready": true` and the styles that the model learned.

The website server does not need TensorFlow. It loads the LSTM's exported NumPy arrays and runs inference. Do not rename the arrays in the artifact; use the notebook export cell.

## Part D — set up Supabase

1. Open your project at <https://supabase.com/dashboard/project/gqhwsmhkxmqbczrckpui>.
2. Open **SQL Editor**, paste all of `supabase_setup.sql`, and run it. It creates the `generations` table, access policies and a **private** `hathor-audio` bucket.
3. In **Authentication → Sign In / Providers**, enable Google and Anonymous sign-in.
4. Configure Google OAuth in Google Cloud Console:
   - You previously pasted a Google client secret in chat. **Rotate/revoke that old client secret first** and create a replacement. Do not put any OAuth client secret in this repository.
   - Under the Google OAuth web client, add this Authorized redirect URI:
     `https://gqhwsmhkxmqbczrckpui.supabase.co/auth/v1/callback`
   - Enter the OAuth client ID and the **new** client secret in Supabase's Google provider settings.
   - After Render gives you a website URL, add that website origin to Google Authorized JavaScript origins and the website URL to Supabase's allowed redirect URLs. Use HTTPS.
5. Check the Supabase **Site URL** and allowed redirect list. They must include your deployed Render origin.

The Supabase URL and publishable key in `static/config.js` are browser settings. The `service_role` JWT key must stay server-side; this app expects the legacy server-only service-role JWT under Render's environment variable `SUPABASE_SERVICE_ROLE_KEY`. Never use the publishable key as the service-role key.

## Part E — deploy on Render

1. Sign in at [Render](https://render.com/), choose **New → Web Service**, and connect `CodeAlpha_HathorAI` from GitHub.
2. Select **Docker** as the runtime. Render will build the included `Dockerfile`; it installs FluidSynth, the GM SoundFont, FFmpeg and the lightweight Python dependencies. Do not select a static site—the backend is required to run the custom LSTM and render audio.
3. Add these environment variables in Render → **Environment**:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://gqhwsmhkxmqbczrckpui.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key (`sb_publishable_...`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Your server-only legacy `service_role` JWT key |
   | `AUDIO_BUCKET` | `hathor-audio` |
   | `SOUNDFONT_PATH` | `/usr/share/sounds/sf2/FluidR3_GM.sf2` |

4. Deploy. Once the service is live, open these endpoints (replace `YOUR-SERVICE` with the actual Render hostname):
   - `https://YOUR-SERVICE.onrender.com/api/health` — checks configuration.
   - `https://YOUR-SERVICE.onrender.com/api/model-info` — checks whether the trained LSTM artifact was found and shows supported genres.
5. Open the root website, test Guest sign-in, generate a short 8-second track, check playback, change volume/speed, download the MP3, refresh history, and test Google login after OAuth redirects have been configured.

Free Render instances may sleep after inactivity and have limited CPU/RAM. The app uses one generation at a time on purpose; a longer composition may take a while to infer and render. Upgrade hosting if you need consistent availability or multiple concurrent users.

## Instrument and music output notes

- The model predicts polyphonic note activity across MIDI pitches; it does not directly synthesize a waveform.
- Selected melodic instruments map to General MIDI SoundFont programs. Veena is currently mapped to a sitar-like GM patch, and Bamboo Flute maps to a pan-flute-like GM patch. SoundFonts vary, so inspect the rendered result on the target server.
- Tabla is represented by GM bongo/conga-like percussion because standard GM percussion does not contain a dedicated tabla sample. Soft Drums use a basic kick/snare/hi-hat pattern.
- Multiple selected melodic instruments are layered at different octaves. This is a practical first arrangement strategy, not a full orchestration model.
- Playback speed in the browser ranges from 0.25× to 10× and affects playback only; the downloaded MP3 remains the rendered track.

The Debian FluidR3 General MIDI SoundFont is used for instrument playback; see FluidSynth documentation for SoundFont requirements and licensing information: <https://www.fluidsynth.org/wiki/GettingStarted/>. The generated notes still come from the Hathor-trained LSTM.

## Troubleshooting

**`model_ready: false`** — Train the notebook, then upload the exact `model/hathor_lstm_weights.npz` file and redeploy.

**Only Classical appears in the style list** — That is expected if the training corpus only contained MAESTRO. Add correctly labelled MIDI folders for other styles and retrain. The app intentionally does not pretend untrained styles are supported.

**`The SoundFont is missing`** — Confirm Render is using Docker and that the build installed `fluid-soundfont-gm`. Check `SOUNDFONT_PATH`.

**Google sign-in fails or redirects to an error** — Rotate the exposed old client secret; set the new one in Supabase; verify the Supabase callback URI in Google Cloud; add the exact Render URL to Supabase allowed redirects and Google Authorized JavaScript origins.

**History or audio saving fails** — Re-run `supabase_setup.sql`; confirm the bucket is private; verify the URL and server-only service-role JWT in Render. Do not expose that key in the browser.

**Audio is sparse/repetitive** — Add more high-quality MIDI data that is licensed for your use, inspect training/validation loss, train another run, and listen to sample outputs. More epochs by themselves do not guarantee musical improvement.

## Licence/reference links

- MAESTRO dataset and MIDI-only download: <https://magenta.tensorflow.org/datasets/maestro>
- MAESTRO licence: <https://creativecommons.org/licenses/by-nc-sa/4.0/>
- FluidSynth: <https://www.fluidsynth.org/>
- Supabase Auth: <https://supabase.com/docs/guides/auth>
- Supabase Row Level Security: <https://supabase.com/docs/guides/database/postgres/row-level-security>
- Render Docker deployment: <https://render.com/docs/docker>
