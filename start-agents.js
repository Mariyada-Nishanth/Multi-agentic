const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const LOGS_FILE = path.join(__dirname, 'dashboard', 'logs.json');
const MAX_LOGS = 200;
const AGENT_NAME_ALIASES = {
  'github-watcher': 'github-agent',
  'travel-concierge': 'travel-agent'
};
const CORE_AGENT_NAMES = ['github-agent', 'researcher-agent', 'travel-agent', 'orchestrator'];

function canonicalAgentName(name) {
  return AGENT_NAME_ALIASES[name] || name;
}

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

function normalizeAgentRegistryData(data) {
  const mergedAgents = new Map();

  for (const rawAgent of data.agents) {
    if (!rawAgent || typeof rawAgent !== 'object') continue;
    const name = canonicalAgentName(String(rawAgent.name || ''));
    if (!name) continue;

    const existing = mergedAgents.get(name);
    if (!existing) {
      mergedAgents.set(name, {
        name,
        status: rawAgent.status || 'running',
        startedAt: rawAgent.startedAt || new Date().toISOString(),
        lastSeen: rawAgent.lastSeen || new Date().toISOString()
      });
      continue;
    }

    const existingStarted = Date.parse(existing.startedAt || '') || Date.now();
    const nextStarted = Date.parse(rawAgent.startedAt || '') || existingStarted;
    const existingSeen = Date.parse(existing.lastSeen || '') || 0;
    const nextSeen = Date.parse(rawAgent.lastSeen || '') || existingSeen;

    existing.startedAt = nextStarted < existingStarted ? (rawAgent.startedAt || existing.startedAt) : existing.startedAt;
    existing.lastSeen = nextSeen > existingSeen ? (rawAgent.lastSeen || existing.lastSeen) : existing.lastSeen;
    if (rawAgent.status === 'running') existing.status = 'running';
  }

  data.agents = Array.from(mergedAgents.values());

  for (const name of CORE_AGENT_NAMES) {
    if (!data.agents.some((agent) => agent && agent.name === name)) {
      data.agents.push({
        name,
        status: 'stopped',
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      });
    }
  }

  data.agents.sort((a, b) => {
    const ai = CORE_AGENT_NAMES.indexOf(a.name);
    const bi = CORE_AGENT_NAMES.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  data.logs = data.logs.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    return { ...entry, agent: canonicalAgentName(String(entry.agent || '')) };
  }).filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return !shouldSuppressDashboardLog(entry.agent, entry.message);
  });

  return data;
}

function migrateDashboardAgentNames() {
  const data = normalizeAgentRegistryData(readLogsData());
  writeLogsData(data);
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

function hasIsoPrefix(message) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(message || ''));
}

function looksLikeNoisyTokenStream(message) {
  const compact = String(message || '').replace(/\s+/g, '');
  if (compact.length < 120) return false;

  const letters = (compact.match(/[A-Za-z]/g) || []).length;
  const vowels = (compact.match(/[AEIOUaeiou]/g) || []).length;
  const symbols = (compact.match(/[_$#@{}\[\]\\|]/g) || []).length;
  const vowelRatio = letters ? (vowels / letters) : 0;

  return (vowelRatio < 0.18 && compact.length > 140) || symbols > 10;
}

function shouldSuppressDashboardLog(agentName, message) {
  if (agentName !== 'orchestrator') return false;
  const text = String(message || '');
  const lower = text.toLowerCase();

  if (lower.includes('[ws] handshake timeout') || lower.includes('[ws] closed before connect')) {
    return true;
  }

  if (!hasIsoPrefix(text) && looksLikeNoisyTokenStream(text)) {
    return true;
  }

  return false;
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
  const normalizedName = canonicalAgentName(agentName);
  const existing = data.agents.find((agent) => agent.name === normalizedName);
  if (existing) {
    existing.status = status;
    existing.lastSeen = nowIso;
  } else {
    data.agents.push({
      name: normalizedName,
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
  const normalizedName = canonicalAgentName(agentName);

  if (shouldSuppressDashboardLog(normalizedName, trimmed)) {
    return;
  }

  const agent = data.agents.find((item) => item.name === normalizedName);
  if (agent) {
    agent.lastSeen = now;
  } else {
    data.agents.push({
      name: normalizedName,
      status: 'running',
      startedAt: now,
      lastSeen: now
    });
  }

  data.logs.push({
    id: `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`,
    time: now,
    agent: normalizedName,
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
  migrateDashboardAgentNames();
  console.log('Starting Autonomous Agent System...\n');

  const watcher = startAgent(
    'github-agent',
    'node',
    ['agents/github/github-watcher.js'],
    { cwd: __dirname }
  );
  console.log('GitHub Agent started (Observe layer)');

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
    upsertAgentStatus('travel-agent', 'running', now);
    appendLog('travel-agent', `travel-agent already running on 127.0.0.1:${travelPort}; startup skipped`);
    console.log(`Travel Agent already running on 127.0.0.1:${travelPort} (Plan layer reused)`);
  } else {
    travelConcierge = startAgent(
      'travel-agent',
      'node',
      ['agents/travel/travel-concierge.js'],
      { cwd: __dirname }
    );
    console.log('Travel Agent started (Plan layer)');
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