# Codex OSS Clone

A local Codex-inspired app with model routing and a desktop launcher for macOS.

## What this does

Before each task runs, the app:

1. classifies task type
2. checks routing rules
3. picks a task-specific model
4. falls back to your selected default model
5. sends the request to the provider

By default, chat/agent execution now runs through the local `codex exec --json` engine so behavior matches Codex runtime semantics. Model routing remains app-defined.
Each UI thread is mapped to a real Codex thread id and follow-up prompts use `codex exec resume`, so conversation continuity follows Codex behavior.

The UI now mirrors Codex-style layout:

- left sidebar with new chat, search, and project/thread lists
- right workspace feed
- bottom-right controls for model, thinking level, and **Go**
- top bar with **Push to GitHub** and live `+added -removed` diff stats
- project folders behave as an accordion (expand/collapse)
- provider settings keep separate model/base URL/API key selections per provider
- workspace panel can open a local folder, browse files, load/edit/save files, and include file context in chat

## Supported task categories

- coding
- reasoning
- writing
- summarization
- general

## Supported routing/model-source presets

- Local CLI Backend (optional FastAPI bridge)
- Ollama
- Custom local OpenAI-compatible endpoint
- Unlimited user-defined local backends from **Settings → Local backends**

## Add local backends quickly (no code changes)

1. Open **Settings**.
2. Under **Local backends**, enter:
   - display name
   - base URL (for example `http://127.0.0.1:1234/v1`)
   - optional API key
3. Click **Add backend**.
4. Pick it in the **Provider** dropdown and click **Load models for provider**.

Backends are saved in browser local storage and can be removed from the same section.

## First-time setup

```bash
cd /Users/yehudazahler/codex-for-open-source/apps/codex-oss-clone
npm install --cache /tmp/codex-npm-cache
```

## Run as a normal desktop app (macOS)

Install the launcher app (one time):

```bash
npm run install:mac-app
```

This creates:

- `~/Applications/VibeCode.app`

Use that app from Finder, Spotlight, or Dock. It starts the local server automatically and opens:

- `http://127.0.0.1:4310`

## Terminal run (optional)

```bash
PORT=4310 npm start
```

Optional backend engine controls:

```bash
# Default: use Codex runtime for /api/chat and /api/agent
VIBECODE_ENGINE=codex PORT=4310 npm start

# Optional: force Codex OSS provider (ollama or lmstudio)
VIBECODE_OSS_PROVIDER=ollama PORT=4310 npm start

# Fallback: use the legacy provider-direct runtime
VIBECODE_ENGINE=provider PORT=4310 npm start
```

## Optional: Local CLI model backend

If you want VibeCode to use a local CLI model runner instead of hosted APIs:

1. Install Python deps:

```bash
cd /Users/yehudazahler/codex-for-open-source/apps/codex-oss-clone/backend
pip install -r requirements.txt
```

2. Start the CLI backend:

```bash
MODEL_CLI_CMD="ollama run qwen2.5:7b" uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

3. In VibeCode, choose provider **Local CLI Backend**.
4. Click **Load models for provider** (it returns one local model id from the backend).

Notes:

- The backend exposes OpenAI-compatible `GET /models` and `POST /chat/completions`.
- You can change the advertised model id with `MODEL_ID`.
- If your CLI expects stdin instead of prompt-arg, set `CLI_PROMPT_MODE=stdin`.

## Stop the local server

```bash
npm run stop
```

## How to use

1. Open **Settings** and set **Workspace path** to your local project folder.
2. Click **Open workspace**, then **Refresh files**.
3. Pick a file from the list (or enter path), click **Load file**, edit, then **Save file**.
4. Select provider and enter API key for that provider.
5. Click **Load models for provider** and pick the fallback model.
6. Configure per-task routing.
7. Enter prompt and click **Go**.
8. Use **Push to GitHub** when ready (the app verifies GitHub remote/auth first).

## Left panel quick actions

- Under **Projects**, click **Open folder** to choose a local workspace folder.
- Under **Projects**, click **Open file** to import a local file into the editor.
- Hover a project row and click `+` to create a new chat in that project.

## Notes

- Routing rules are saved in browser local storage.
- Task classification is heuristic.
- The app expects OpenAI-compatible `/models` and `/chat/completions` APIs.
