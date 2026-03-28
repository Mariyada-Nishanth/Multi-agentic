#  Multi-Agents

A compact multi-agent runtime for GitHub monitoring, travel planning, and OpenClaw-backed decision support.

## What This Project Does

- Runs multiple local agents from one launcher.
- Streams agent logs into a dashboard feed.
- Uses a same-origin dashboard backend that proxies prompts to OpenClaw.
- Includes an "agents council" endpoint for structured approve/reject/escalate decisions with latency metrics.

## Components

- Launcher: `start-agents.js`
- Dashboard server: `dashboard/server.js` (default http://127.0.0.1:8080)
- GitHub watcher + researcher: `agents/github/`
- Travel concierge and machine modules: `agents/travel/`
- Runtime config: `config/github-watch.json`, `config/travel-watch.json`

## Backend Flow

1. `start-agents.js` starts and tracks all agent processes.
2. Agent logs and statuses are written to `dashboard/logs.json`.
3. `dashboard/server.js` serves `dashboard/index.html` and exposes API routes.
4. Frontend uses same-origin API calls to avoid CORS problems.
5. Council calls run role-based model votes and return decision + per-role latency.

## Prerequisites

- Node.js 18+
- OpenClaw installed and available in PATH
- Valid API tokens in config files (GitHub token required for repo discovery)

## Quick Start

1. Install dependencies:

	 ```bash
	 npm install
	 ```

2. Prepare config files:

	 - Copy `config/github-watch.example.json` -> `config/github-watch.json`
	 - Copy `config/travel-watch.example.json` -> `config/travel-watch.json`
	 - Fill required tokens and host/port values

3. Start agents:

	 ```bash
	 npm start
	 ```

4. Start dashboard server (new terminal):

	 ```bash
	 npm run dashboard
	 ```

5. Open dashboard:

	 - http://127.0.0.1:8080
	 - Council tab direct URL: http://127.0.0.1:8080/#council

## Runtime Notes

- The launcher starts:
	- `github-agent`
	- `researcher-agent`
	- `travel-agent` (if its port is not already in use)
	- `orchestrator` via `openclaw gateway run` (if port 18789 is free)
- Logs are persisted to `dashboard/logs.json`.
- Press Ctrl+C in the launcher terminal to stop spawned processes.

## API Endpoints (Dashboard Server)

- `GET /api/dashboard/config`
- `GET /api/github/repos`
- `POST /api/github/repo/select`
- `POST /api/openclaw/chat`
- `POST /api/agents-council/run`

Example council request:

```bash
curl -X POST http://127.0.0.1:8080/api/agents-council/run \
	-H "Content-Type: application/json" \
	-d '{"problem":"Critical bug in checkout flow causing duplicate charge risk"}'
```

Example council response fields:

- `decision`: `auto-execute`, `halt-and-escalate`, or `escalate-human`
- `votes`: approve/reject/needsHuman counts
- `latencyMs`: total council runtime in milliseconds
- `slowestRole`: role name and latency for bottleneck role
- `agents[]`: role outputs with `vote`, `model`, `engine`, `latencyMs`, `recommendation`, `rationale`, `actions`

## Council Tuning (Env Vars)

- `COUNCIL_GATEWAY_FALLBACK`
	- `0` (default): fast-fail mode (direct Featherless only)
	- `1`: fallback to gateway path if direct call fails
- `COUNCIL_ROLE_TIMEOUT_MS`
	- Per-role time budget in ms (default `6000`)
- `COUNCIL_MAX_MODELS_PER_ROLE`
	- Max model attempts per role (default `1`)
- `COUNCIL_ROLE_CONCURRENCY`
	- Parallel role workers (default `3`, max `4`)

## Troubleshooting

- If `npm start` exits early:
	- verify `openclaw` CLI is installed and runnable
	- confirm required config JSON files exist and are valid
- If you see `EADDRINUSE`:
	- another process is already using the port (commonly 8080 or 18789)
	- stop the old process or run dashboard on a different port via `DASHBOARD_PORT`
- If dashboard cannot reach gateway:
	- check `openclaw_base`, `openclaw_port`, and `openclaw_chat_paths` in `config/github-watch.json`
- If GitHub repos are empty:
	- verify `github_token` and token scopes

## Repository Layout

```text
agents/      agent implementations and machine modules
config/      runtime JSON config + examples
dashboard/   static UI, API server, and logs
start-agents.js  process launcher and log collector
```
