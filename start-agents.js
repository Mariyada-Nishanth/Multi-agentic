const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOGS_FILE = path.join(__dirname, 'dashboard', 'logs.json');
const MAX_LOGS = 200;

function ensureLogsFile() {
  const dashboardDir = path.dirname(LOGS_FILE);
  if (!fs.existsSync(dashboardDir)) {
    fs.mkdirSync(dashboardDir, { recursive: true });
  }
  if (!fs.existsSync(LOGS_FILE)) {
    fs.writeFileSync(LOGS_FILE, JSON.stringify({ agents: [], logs: [] }, null, 2));
  }
}

function readLogsData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    if (!Array.isArray(parsed.agents)) parsed.agents = [];
    if (!Array.isArray(parsed.logs)) parsed.logs = [];
    return parsed;
  } catch {
    return { agents: [], logs: [] };
  }
}

function writeLogsData(data) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(data, null, 2));
}

function sanitizeDashboardLog(message) {
  return String(message || '')
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ');
}

function detectLevel(message) {
  const lower = message.toLowerCase();
  if (message.includes('error') || message.includes('ERROR') || lower.includes('error')) {
    return 'error';
  }
  if (message.includes('⚠') || message.includes('URGENT') || lower.includes('warn')) {
    return 'warn';
  }
  if (message.includes('✅') || lower.includes('posted') || lower.includes('success') || lower.includes('started')) {
    return 'success';
  }
  return 'info';
}

function upsertAgentStatus(agentName, status, nowIso) {
  const data = readLogsData();
  const existing = data.agents.find((agent) => agent.name === agentName);
  if (existing) {
    existing.status = status;
    existing.lastSeen = nowIso;
  } else {
    data.agents.push({
      name: agentName,
      status,
      startedAt: nowIso,
      lastSeen: nowIso
    });
  }
  writeLogsData(data);
}

function appendLog(agentName, message) {
  const trimmed = sanitizeDashboardLog(message).trim();
  if (!trimmed) return;

  const now = new Date().toISOString();
  const data = readLogsData();
  const agent = data.agents.find((item) => item.name === agentName);
  if (agent) {
    agent.lastSeen = now;
  } else {
    data.agents.push({
      name: agentName,
      status: 'running',
      startedAt: now,
      lastSeen: now
    });
  }

  data.logs.push({
    id: `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`,
    time: now,
    agent: agentName,
    level: detectLevel(trimmed),
    message: trimmed
  });

  if (data.logs.length > MAX_LOGS) {
    data.logs = data.logs.slice(data.logs.length - MAX_LOGS);
  }

  writeLogsData(data);
}

function attachStreamLogger(child, agentName, stream, output) {
  let buffer = '';
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    output.write(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      appendLog(agentName, line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) {
      appendLog(agentName, buffer);
      buffer = '';
    }
  });

  child.on('error', (err) => {
    const line = `[${agentName}] process error: ${err.message}`;
    process.stderr.write(`${line}\n`);
    appendLog(agentName, line);
  });
}

function startAgent(name, command, args, options) {
  const child = spawn(command, args, options);
  const now = new Date().toISOString();
  upsertAgentStatus(name, 'running', now);
  appendLog(name, `${name} started`);

  if (child.stdout) {
    attachStreamLogger(child, name, child.stdout, process.stdout);
  }
  if (child.stderr) {
    attachStreamLogger(child, name, child.stderr, process.stderr);
  }

  child.on('exit', (code, signal) => {
    const endTime = new Date().toISOString();
    upsertAgentStatus(name, 'stopped', endTime);
    appendLog(name, `${name} exited with code ${code} signal ${signal || 'none'}`);
  });

  return child;
}

ensureLogsFile();
console.log('Starting Autonomous Agent System...\n');

const watcher = startAgent(
  'github-watcher',
  'node',
  ['agents/github/github-watcher.js'],
  { cwd: __dirname }
);
console.log('GitHub Watcher started (Observe layer)');

const travelConcierge = startAgent(
  'travel-concierge',
  'node',
  ['agents/travel/travel-concierge.js'],
  { cwd: __dirname }
);
console.log('Travel Concierge started (Plan layer)');

const gateway = startAgent(
  'orchestrator',
  'openclaw',
  ['gateway', 'run'],
  { cwd: __dirname, shell: true }
);
console.log('Orchestrator started (Decide layer)');

process.on('SIGINT', () => {
  console.log('\nShutting down all agents...');
  watcher.kill();
  travelConcierge.kill();
  gateway.kill();
  process.exit();
});

console.log('\nAll agents running. Press Ctrl+C to stop everything.\n');