# OpenClaw Agents

A compact multi-agent runtime for GitHub monitoring, travel planning, and OpenClaw-backed decision support.

## What This Project Does

- Runs multiple local agents from one launcher.
- Streams agent logs into a dashboard feed.
- Proxies dashboard prompts to an OpenClaw gateway.
- Includes an "agents council" endpoint for structured approve/reject/escalate decisions.

## Components

- Launcher: `start-agents.js`
- Dashboard server: `dashboard/server.js` (default http://127.0.0.1:8080)
- GitHub watcher + researcher: `agents/github/`
- Travel concierge and machine modules: `agents/travel/`
- Runtime config: `config/github-watch.json`, `config/travel-watch.json`

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

## Troubleshooting

- If `npm start` exits early:
	- verify `openclaw` CLI is installed and runnable
	- confirm required config JSON files exist and are valid
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