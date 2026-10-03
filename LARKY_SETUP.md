# Larky Setup

Larky is a desktop-first gaming AI chat app with a server API. Gemini is the primary text and image provider; Ollama and Automatic1111/Forge remain selectable local backups. Accounts, chat history, roles, quotas, settings, and moderation state are stored by the server.

## Start the app

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

For local Gemini access, copy `.env.example` to `.env`, put a **newly rotated** Google key in `GEMINI_API_KEY`, then restart `npm run dev`. Never paste the key into source code or commit `.env`. A key posted in a chat should be revoked in Google AI Studio/Cloud and replaced.

Create a user account from **Registrieren**. The only administrator accounts are `leon.batzel@freenet.de` and `ytcoolcaster3@gmail.com`. On first run, generated admin passwords are placed in `server/admin-first-login.txt`; note them and remove that file. You can set `LARKY_LEON_PASSWORD` and `LARKY_YTCOOLCASTER_PASSWORD` before the first launch instead. Admin passwords are never printed to the terminal.

The Admin area includes verified badges, per-user image limits, chat review, timeout/kick/ban controls, an audit log, and a system lockdown. Ban records show the moderator, reason, and expiry. The hidden break-glass code is checked by the local server, rate-limited, and audited. Lockdown denies user actions while administrators retain access.

The **Rollen** area is visible only to `leon.batzel@freenet.de`. Leon can create roles, grant individual capabilities, and assign roles to users. API routes check those capabilities server-side. Both allowlisted administrators retain the developer workbench.

## Connect a local chat model
## Google Gemini (Primary)

Set `GEMINI_API_KEY` in the ignored local `.env` file or in the Render service's secret environment variables. The browser never receives this value. In **Admin → Systeme → Google Gemini**, choose the chat/image models and test the connection. Image generation/editing uses the configured Gemini image model; Google account/model access and quota are required.

## Ollama (Backup)

Install and start [Ollama](https://ollama.com/), then download a model:

```powershell
ollama pull llama3.2
```

Choose the **Ollama Backup** tab to switch chat requests to the backup. The default URL is `http://127.0.0.1:11434`. On Render, `localhost` refers to the Render server, not your PC; remote Ollama requires an HTTPS hostname listed in `LARKY_ALLOWED_AI_HOSTS`.

## Connect local image generation
## Local image backup

When Ollama is selected, start AUTOMATIC1111 Stable Diffusion WebUI or Forge with its API enabled, for example:

```text
--api --cors-allow-origins=http://localhost:5173
```

Set the WebUI URL in the Ollama backup settings (default `http://127.0.0.1:7860`). Generation uses `txt2img`; editing uses `img2img` and requires an image selected by the signed-in user.

## What the tools do

- Chat, text rephrasing, code drafts, and test-code drafts use the selected Gemini or Ollama provider.
- Gemini uses its configured image model; Ollama backup image requests use the configured local WebUI.
- Generated tests are drafts; Larky does not execute code or run a test suite.
- Admin connection checks report whether each local service responds. Unavailable tools are not simulated.
- Account roles, moderation, quotas, and lockdown are checked by the local API, not just by the UI.
- Larky has no autonomous filesystem search or PC control. A file is sent only after the signed-in user selects it in the file picker.
- Larky has no autonomous filesystem search or PC control. A file is sent only after the signed-in user selects it in the file picker.
- User accounts and chats follow the server. A Render deployment with the persistent disk in `render.yaml` makes the same account available across devices. A local database and Render database are separate; local accounts are not copied automatically.

The JSON database contains account hashes, chat text, and image data. Keep it private. Render's persistent disk requires a paid persistent-disk plan and the app should run as one service instance because the current database is a single JSON file.

## GitHub and Render

1. Create a private GitHub repository and push this project. The included GitHub Action runs lint and build on pushes to `main`.
2. In Render, create a Blueprint from that repository and review `render.yaml`.
3. Set `GEMINI_API_KEY` and both admin password environment variables as Render secrets. Use a newly generated Google key; do not reuse a key posted in a chat.
4. The Blueprint mounts a persistent disk at `/var/data`; account data is shared across devices through that deployment.

GitHub is not connected from this machine yet. The `git` executable is not installed, so the repository cannot be pushed automatically here; the source, workflow, and Render Blueprint are prepared for upload.

## Commands

```powershell
npm run dev
npm run build
npm run lint
```
