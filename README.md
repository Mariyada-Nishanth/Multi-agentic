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
3. Copy `config/travel-watch.example.json` to `config/travel-watch.json`.
4. Fill in your GitHub and travel API key values.
5. Run `node start-agents.js`.
6. Open `dashboard/index.html` in a browser.

## Travel Concierge Flow

The new travel agent runs continuously and follows this machine pipeline:

Dashboard Prompt -> ORACLE (intent parse) -> SENTINEL (flight scan) + WEATHER (forecast) + GUARDIAN (budget/safety) + OPTIMIZER (best value) -> Agent Negotiation Round -> Complete itinerary auto-booked (simulated) + shared in dashboard response.

Integrations in this flow:

- aviationstack API for live flight data.
- OpenWeather API for forecast and risk estimation.

Auto-booking in v1 is intentionally simulated (no payment booking provider yet).

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