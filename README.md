# OpenClaw Agents

Autonomous AI agents that monitor GitHub activity and route analysis through OpenClaw.

## Architecture

Flow:

GitHub Issue -> github-watcher.js -> OpenClaw Gateway (localhost:18789) -> Groq LLM -> GitHub Comment posted automatically

## Prerequisites

- Node.js 18+
- OpenClaw installed and running
- Groq API key configured inside OpenClaw

## Setup

1. Clone this project.
2. Copy `config/github-watch.example.json` to `config/github-watch.json`.
3. Fill in your GitHub repo and token values.
4. Run `node start-agents.js`.
5. Open `dashboard/index.html` in a browser.

## How To Add A New Agent

1. Create a folder under `agents/`.
2. Add your Node.js agent script in that folder.
3. Register a new spawn entry in `start-agents.js` so it starts with the rest.

## File Structure

- `agents/github/`: GitHub watcher and researcher agent files.
- `agents/email/`: Placeholder for email monitor agent soul/spec.
- `config/`: Runtime config and example template.
- `dashboard/`: Browser dashboard and runtime logs JSON.
- `start-agents.js`: Main process launcher and log collector.
- `package.json`: Project metadata and start script.