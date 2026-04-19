# Claude Max API Proxy

> OpenAI-compatible HTTP API backed by the Claude Code CLI, with a built-in chat UI and Docker/Railway deploy. Use your Claude Max subscription ($200/mo) with any OpenAI client — no per-token API fees.

Fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with OpenClaw integration, improved streaming, bearer-token auth, and a polished web UI.

## Why

| Approach | Cost | Limitation |
|---|---|---|
| Anthropic API | ~$15/M input, ~$75/M output | Pay per token |
| Claude Max | $200/mo flat | OAuth blocked for third-party API use |
| **This proxy** | $0 extra (uses Max) | Routes through Claude Code CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients, but the Claude Code CLI *can* use them. This proxy wraps the CLI as a subprocess and exposes a standard OpenAI-compatible API.

## What's new in this fork

- **Default model: Claude Opus 4.6** (`claude-opus-4-6`) — pinned, not a rolling alias
- **Built-in chat UI** at `/chat` — Claude-esque design, streaming, markdown, syntax highlighting, sidebar with saved conversations
- **Landing page** at `/` — browser-friendly status instead of a 404
- **Bearer-token auth** via `PROXY_API_KEY` — safe to expose publicly
- **Dockerfile + entrypoint** for Railway / any container host
- **Auto 0.0.0.0 binding** when `PORT` env var is set (Railway-style)
- **Model selector** with `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- **OpenClaw tool mapping** — translates OpenClaw tool names (`exec`, `read`, `web_search`, …) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System-prompt stripping** — removes OpenClaw-specific sections that conflict with Claude Code's native tools

## How it works

```
Your client (OpenAI SDK, Continue, chat UI, …)
       ↓  OpenAI-format HTTP
Claude Max API Proxy  ──── /chat (web UI)
       ↓  spawn()
Claude Code CLI (--print mode, stream-json)
       ↓  OAuth (Max subscription)
Anthropic API
```

## Prerequisites

1. **Claude Max subscription**
2. **Claude Code CLI** installed & authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Local usage

```bash
git clone https://github.com/wende/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
npm start
```

Default port **3456**. Pass a custom one: `node dist/server/standalone.js 8080`.

- Web UI → <http://localhost:3456/chat>
- Status page → <http://localhost:3456/>
- API base → `http://localhost:3456/v1`

### Test

```bash
curl http://localhost:3456/health
curl http://localhost:3456/v1/models

curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "messages": [{"role":"user","content":"Hello!"}]
  }'
```

Streaming (add `-N` to curl for unbuffered output):

```bash
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hi!"}],"stream":true}'
```

## Deploying to Railway

Railway (or any container host) works out of the box via the included `Dockerfile`.

1. **Get your Claude credentials.** On the machine where you ran `claude auth login`:
   ```bash
   cat ~/.claude/.credentials.json   # Linux / Windows
   # macOS: check ~/.claude/.credentials.json first; if empty, try:
   security find-generic-password -s "Claude Code-credentials" -w
   ```
   Copy the whole JSON blob.

2. **Create the Railway project.**
   - New Project → Deploy from GitHub Repo → pick this fork
   - Railway auto-detects the `Dockerfile`; no config needed

3. **Set environment variables:**
   | Variable | Value |
   |---|---|
   | `CLAUDE_CREDENTIALS_JSON` | Paste the full contents of `~/.claude/.credentials.json` |
   | `PROXY_API_KEY` | A long random string, e.g. `openssl rand -hex 32` |

4. **Generate a domain** under Settings → Networking.

5. **Use it:**
   ```bash
   curl https://your-app.up.railway.app/v1/chat/completions \
     -H "Authorization: Bearer $PROXY_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hi!"}]}'
   ```

   Or open the web UI at `https://your-app.up.railway.app/chat` — paste your `PROXY_API_KEY` into the sidebar field once and it's remembered.

See [`.env.example`](./.env.example) for all supported env vars.

### Token refresh note

The Claude OAuth token rotates every few weeks. The CLI writes a new `.credentials.json` inside the container, but Railway containers are ephemeral — on restart you fall back to the stale env var. If you see 401s from Anthropic, re-copy `~/.claude/.credentials.json` into `CLAUDE_CREDENTIALS_JSON` on Railway.

## Auth

- If `PROXY_API_KEY` is **set**, every `/v1/*` request must include `Authorization: Bearer <key>`
- If **unset**, `/v1` is open (fine for `127.0.0.1`, dangerous on a public host)
- `/`, `/chat`, `/health` are always open (no key required for the browser UI shell)

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Landing page |
| GET | `/chat` | Built-in chat UI |
| GET | `/health` | Health check |
| GET | `/v1/models` | List models (auth required if key set) |
| POST | `/v1/chat/completions` | Chat completions, streaming & non-streaming |

## Models

| ID | Backing model |
|---|---|
| `claude-opus-4-6` **(default)** | Claude Opus 4.6 |
| `claude-opus-4-7` | Claude Opus 4.7 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |

Unknown model IDs default to `claude-opus-4-6`. Aliases `opus`, `sonnet`, `haiku` map to the pinned defaults above. Provider prefixes `claude-code-cli/` and `claude-max/` are stripped.

## Client examples

### Python (openai SDK)
```python
from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:3456/v1",              # or your Railway URL
    api_key="your-PROXY_API_KEY-or-anything-locally",
)
r = client.chat.completions.create(
    model="claude-opus-4-6",
    messages=[{"role":"user","content":"Hello!"}],
)
print(r.choices[0].message.content)
```

### Node (openai SDK)
```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://localhost:3456/v1",
  apiKey:  "your-PROXY_API_KEY",
});
```

### Continue.dev
```json
{
  "models": [{
    "title": "Claude Max",
    "provider": "openai",
    "model": "claude-opus-4-6",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "your-PROXY_API_KEY"
  }]
}
```

## Chat UI features

The `/chat` page is a self-contained single-page app:

- Streaming responses with live markdown + syntax-highlighted code blocks
- Sidebar with saved conversations (auto-titled, delete on hover)
- Model picker, persisted per-browser
- API key input (stored in `localStorage`)
- Dark / light mode that follows your OS
- `Enter` to send, `Shift+Enter` newline, `Cmd/Ctrl+K` new chat
- Copy buttons on code blocks and entire messages
- Thinking indicator while waiting for the first token
- Mobile responsive

## macOS auto-start (alternative to Railway)

A LaunchAgent plist is included for persistent local running on port 3456:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy     # restart
launchctl bootout   gui/$(id -u)/com.openclaw.claude-max-proxy        # stop
launchctl list com.openclaw.claude-max-proxy                          # status
```

Logs: `~/.openclaw/logs/claude-max-proxy.log` and `.err.log`.

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (tool calls, etc.)
├── adapter/
│   ├── openai-to-cli.ts   # OpenAI request → CLI input (model map, default Opus 4.6)
│   └── cli-to-openai.ts   # CLI output → OpenAI response
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess + OpenClaw tool mapping prompt
├── session/
│   └── manager.ts         # Session ID mapping
└── server/
    ├── index.ts           # Express setup, bearer auth, 0.0.0.0 binding
    ├── routes.ts          # API routes + /chat UI + landing page
    └── standalone.ts      # Entry point (reads PORT, CLI arg)
Dockerfile                 # Node 20 + Claude Code CLI
docker-entrypoint.sh       # Writes CLAUDE_CREDENTIALS_JSON → ~/.claude/.credentials.json
.env.example               # Supported env vars
```

## Security

- Uses `spawn()` not shell exec — no injection surface
- Prompt passed via stdin (no arg-length limits, no shell interpolation)
- No API keys stored or logged by this proxy
- Claude Code CLI manages OAuth tokens in the OS keychain locally / from env var in containers
- `PROXY_API_KEY` bearer guard on `/v1` when set

## Usage & risk

This proxy is intended for **personal use**. Using your Claude Max subscription programmatically from a machine you control (laptop, your own VPS, your own Railway project) is fine. **Don't** publicly share the URL + key, run it as a paid service, embed it in a product with other users, or hammer it 24/7 at API scale — that's against Anthropic's ToS and will get your account suspended.

Set an Anthropic usage alarm so you notice quickly if something goes wrong.

## Troubleshooting

**"Claude CLI not found"** — install & auth: `npm install -g @anthropic-ai/claude-code && claude auth login`

**Streaming returns immediately with no content** — use `curl -N` to disable buffering.

**401 from the proxy** — `PROXY_API_KEY` is set; add `Authorization: Bearer <key>` to the request (or enter it in the chat UI sidebar).

**401 from Anthropic** (not the proxy) — OAuth token is stale on Railway. Re-copy `~/.claude/.credentials.json` into `CLAUDE_CREDENTIALS_JSON`.

**Server won't start** — check `which claude` (or `where claude` on Windows) resolves.

## License

MIT

## Acknowledgments

- Originally by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
