const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

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

function readTravelApiPort() {
  try {
    const travelConfigPath = path.join(__dirname, 'config', 'travel-watch.json');
    const raw = fs.readFileSync(travelConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    const configured = Number(parsed.prompt_api_port || 18890);
    return Number.isFinite(configured) ? configured : 18890;
  } catch {
    return 18890;
  }
}

function isLocalPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    socket.setTimeout(800);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function bootstrap() {
  ensureLogsFile();
  console.log('Starting Autonomous Agent System...\n');

  const watcher = startAgent(
    'github-watcher',
    'node',
    ['agents/github/github-watcher.js'],
    { cwd: __dirname }
  );
  console.log('GitHub Watcher started (Observe layer)');

  const researcher = startAgent(
    'researcher-agent',
    'node',
    ['agents/github/researcher-agent.js'],
    { cwd: __dirname }
  );
  console.log('Researcher Agent started (Analyze layer)');

  const travelPort = readTravelApiPort();
  const travelAlreadyRunning = await isLocalPortListening(travelPort);

  let travelConcierge = null;
  if (travelAlreadyRunning) {
    const now = new Date().toISOString();
    upsertAgentStatus('travel-concierge', 'running', now);
    appendLog('travel-concierge', `travel-concierge already running on 127.0.0.1:${travelPort}; startup skipped`);
    console.log(`Travel Concierge already running on 127.0.0.1:${travelPort} (Plan layer reused)`);
  } else {
    travelConcierge = startAgent(
      'travel-concierge',
      'node',
      ['agents/travel/travel-concierge.js'],
      { cwd: __dirname }
    );
    console.log('Travel Concierge started (Plan layer)');
  }

  const gatewayPort = 18789;
  const gatewayAlreadyRunning = await isLocalPortListening(gatewayPort);

  let gateway = null;
  if (gatewayAlreadyRunning) {
    const now = new Date().toISOString();
    upsertAgentStatus('orchestrator', 'running', now);
    appendLog('orchestrator', `gateway already running on 127.0.0.1:${gatewayPort}; startup skipped`);
    console.log(`Orchestrator already running on 127.0.0.1:${gatewayPort} (Decide layer reused)`);
  } else {
    gateway = startAgent(
      'orchestrator',
      'openclaw',
      ['gateway', 'run'],
      { cwd: __dirname, shell: true }
    );
    console.log('Orchestrator started (Decide layer)');
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down all agents...');
    if (watcher) watcher.kill();
    if (researcher) researcher.kill();
    if (travelConcierge) travelConcierge.kill();
    if (gateway) gateway.kill();
    process.exit();
  });

  console.log('\nAll agents running. Press Ctrl+C to stop everything.\n');
}

bootstrap().catch((error) => {
  console.error(`error startup failed: ${error.message}`);
  process.exit(1);
});