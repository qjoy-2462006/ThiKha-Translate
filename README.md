<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/612b9d0a-e720-4fba-a015-5d02830ac520

## Run Locally

**Prerequisites:** Node.js, Python 3, [Pyidaungsu.ttf](https://www.dayone.gov.mm/mm/fonts) in the project root (or set `MYANMAR_FONT_PATH`).

1. **Node:** `npm install`
2. **Python (recommended):** `pip install -r requirements.txt`  
   On Windows the server uses the `python` command by default; override with `PYTHON_BIN` if needed.
3. **API key (choose one):**
   - Enter your Gemini API key in the web UI (stored in `sessionStorage` for that tab only; sent as `x-gemini-api-key` to your local server), or
   - Optionally set `GEMINI_API_KEY` in `.env.local` (loaded automatically by the server).
4. **Run:** `npm run dev` → open [http://localhost:3000](http://localhost:3000)

**Python-only UI (Gradio):** `pip install -r requirements.txt` then `python app.py` → [http://127.0.0.1:7860](http://127.0.0.1:7860). Public `gradio.live` links are off by default; set `THIKHA_GRADIO_SHARE=true` to enable sharing.

## Docker (single image — recommended)

One container runs **Node (Express + static UI)** and **Python (PDF pipeline)** together — same behaviour as local `npm run build` + `npm start`.

1. Ensure **`pyidaungsu.ttf`** is in the project root (already expected for local runs).
2. From the project root:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:3000** (or set `PORT` in your shell / `.env` for a different host port mapping).

Optional: create a `.env` next to `docker-compose.yml` with `GEMINI_API_KEY=...` so the server has a default key; users can still paste a key in the UI.

Image details: see [Dockerfile](Dockerfile) (multi-stage build) and [docker-compose.yml](docker-compose.yml). Python API dependencies are listed in [requirements-docker.txt](requirements-docker.txt) (no Gradio — smaller image).
