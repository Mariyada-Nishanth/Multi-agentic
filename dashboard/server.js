const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8080);
const GITHUB_WATCH_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'github-watch.json');
const OPENCLAW_RUNTIME_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const COUNCIL_ROLE_MODEL_PRESETS = {
  researcher: ['EldritchLabs/MN-12B-Mag-Mell-R1-Uncensored-Scale1.2', 'Aether-Agi/aether-v4'],
  security: ['EldritchLabs/MN-12B-Mag-Mell-R1-Uncensored-Scale1.2', 'Aether-Agi/aether-v4'],
  coder: ['EldritchLabs/MN-12B-Mag-Mell-R1-Uncensored-Scale1.2', 'Aether-Agi/aether-v4'],
  reviewer: ['EldritchLabs/MN-12B-Mag-Mell-R1-Uncensored-Scale1.2', 'Aether-Agi/aether-v4'],
  notifier: ['EldritchLabs/MN-12B-Mag-Mell-R1-Uncensored-Scale1.2', 'Aether-Agi/aether-v4']
};

let openclawConfigCache = null;
let openclawConfigCacheAt = 0;

function readGithubWatchConfig() {
  try {
    return JSON.parse(fs.readFileSync(GITHUB_WATCH_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeGithubWatchConfig(cfg) {
  fs.writeFileSync(GITHUB_WATCH_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function readOpenClawRuntimeConfig() {
  const now = Date.now();
  if (openclawConfigCache && now - openclawConfigCacheAt < 15000) {
    return openclawConfigCache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(OPENCLAW_RUNTIME_CONFIG_PATH, 'utf8'));
    openclawConfigCache = parsed;
    openclawConfigCacheAt = now;
    return parsed;
  } catch {
    return null;
  }
}

function resolveFeatherlessConfig() {
  const runtimeCfg = readOpenClawRuntimeConfig();
  if (!runtimeCfg || !runtimeCfg.models || !runtimeCfg.models.providers) {
    return null;
  }

  const providers = runtimeCfg.models.providers;
  const providerEntry = Object.entries(providers).find(([, value]) => {
    const base = String(value && value.baseUrl || '').toLowerCase();
    return base.includes('api.featherless.ai');
  });

  if (!providerEntry) return null;
  const [providerKey, provider] = providerEntry;
  const apiKey = String(provider.apiKey || '').trim();
  const baseUrl = String(provider.baseUrl || '').trim();
  const models = Array.isArray(provider.models) ? provider.models.map((item) => String(item && item.id || '').trim()).filter(Boolean) : [];
  const defaultModelRef = String(runtimeCfg.agents && runtimeCfg.agents.defaults && runtimeCfg.agents.defaults.model || '').trim();

  return {
    providerKey,
    apiKey,
    baseUrl,
    models,
    defaultModelRef
  };
}

function normalizeRepoEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const owner = String(entry.owner || '').trim();
  const repo = String(entry.repo || '').trim();
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    actions: entry.actions && typeof entry.actions === 'object'
      ? entry.actions
      : {
          new_issue: 'label it, post a welcome comment, flag if bug',
          new_pr: 'summarize changes, post review request'
        }
  };
}

function dedupeRepos(repos) {
  const seen = new Set();
  const out = [];
  for (const raw of repos || []) {
    const normalized = normalizeRepoEntry(raw);
    if (!normalized) continue;
    const key = `${normalized.owner}/${normalized.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function fetchGithubUserRepos(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve([]);
      return;
    }

    const req = https.request({
      hostname: 'api.github.com',
      path: '/user/repos?per_page=100&sort=updated&direction=desc',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'central-ops-dashboard',
        Accept: 'application/vnd.github+json'
      },
      timeout: 12000
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          resolve([]);
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            resolve([]);
            return;
          }

          const repos = parsed.map((item) => ({
            owner: String(item && item.owner && item.owner.login || '').trim(),
            repo: String(item && item.name || '').trim(),
            actions: {
              new_issue: 'label it, post a welcome comment, flag if bug',
              new_pr: 'summarize changes, post review request'
            }
          }));
          resolve(dedupeRepos(repos));
        } catch {
          resolve([]);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function parseRepoFullName(value) {
  const full = String(value || '').trim();
  const parts = full.split('/').map((item) => item.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  if (/\s/.test(parts[0]) || /\s/.test(parts[1])) return null;
  return { owner: parts[0], repo: parts[1] };
}

function serializeRepo(entry) {
  return {
    owner: entry.owner,
    repo: entry.repo,
    fullName: `${entry.owner}/${entry.repo}`
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function safeResolveDashboardPath(urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const clean = path.normalize(relative).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, clean);
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendGatewayRequest(pathname, body, token, host, port) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request({
      host,
      port,
      path: pathname,
      method: 'POST',
      headers,
      timeout: 25000
    }, (resp) => {
      let raw = '';
      resp.on('data', (chunk) => {
        raw += chunk;
      });
      resp.on('end', () => {
        resolve({ status: resp.statusCode || 0, raw });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Gateway request timed out'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractResponseText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.reply === 'string') return data.reply;
  if (typeof data.response === 'string') return data.response;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.output === 'string') return data.output;
  if (typeof data.message === 'string') return data.message;
  if (typeof data.content === 'string') return data.content;

  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (choice && typeof choice.text === 'string') return choice.text;

  return '';
}

function extractBalancedJsonObject(inputText) {
  const text = String(inputText || '');
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseCouncilAgentReply(rawText, agentId) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const objectText = extractBalancedJsonObject(candidate);
    if (!objectText) continue;

    const attempts = [
      objectText,
      objectText.replace(/,\s*([}\]])/g, '$1')
    ];

    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        const vote = String(parsed.vote || '').toLowerCase();
        const recommendation = String(parsed.recommendation || '').trim().slice(0, 140);
        const rationale = String(parsed.rationale || '').trim().slice(0, 280);
        const actions = Array.isArray(parsed.actions)
          ? parsed.actions
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 2)
          : [];
        return {
          // Always pin result to the requested role to avoid cross-role label drift.
          agent: agentId,
          vote: vote === 'approve' || vote === 'reject' || vote === 'needs-human' ? vote : 'needs-human',
          recommendation: recommendation || 'short',
          rationale,
          actions
        };
      } catch {
      }
    }
  }

  return {
    agent: agentId,
    vote: 'needs-human',
    recommendation: 'Model response was not strict JSON.',
    rationale: text.slice(0, 300),
    actions: []
  };
}

async function proxyGatewayChat(message, options = {}) {
  const session = String(options.session || 'dashboard');
  const agent = String(options.agent || 'main');
  const cfg = readGithubWatchConfig();
  const host = String(cfg.openclaw_base || '127.0.0.1');
  const port = Number(cfg.openclaw_port || 18789);
  const model = String(cfg.openclaw_model || 'openclaw');
  const chatPaths = Array.isArray(cfg.openclaw_chat_paths) && cfg.openclaw_chat_paths.length
    ? cfg.openclaw_chat_paths
    : ['/v1/chat/completions', '/api/v1/chat', '/api/chat', '/chat'];
  const token = String(cfg.openclaw_http_token || cfg.openclaw_ws_token || '').trim();

  let lastError = 'Gateway unreachable';

  for (const pathname of chatPaths) {
    try {
      const body = pathname === '/v1/chat/completions'
        ? {
            model,
            messages: [{ role: 'user', content: message }]
          }
        : {
            message,
            session,
            agent
          };

      const result = await sendGatewayRequest(pathname, body, token, host, port);
      if (result.status === 404 || result.status === 405) {
        lastError = `${pathname} -> HTTP ${result.status}`;
        continue;
      }
      if (result.status >= 400) {
        lastError = `${pathname} -> HTTP ${result.status}`;
        continue;
      }

      let data = {};
      try {
        data = result.raw ? JSON.parse(result.raw) : {};
      } catch {
        data = {};
      }

      const text = extractResponseText(data) || String(result.raw || '').trim();
      return {
        ok: true,
        via: pathname,
        text,
        raw: result.raw || ''
      };
    } catch (err) {
      lastError = err && err.message ? err.message : 'Gateway request failed';
    }
  }

  return {
    ok: false,
    error: lastError
  };
}

async function proxyGlobalChat(message) {
  return proxyGatewayChat(message, { session: 'dashboard', agent: 'main' });
}

function requestFeatherlessChat({ apiKey, model, messages, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 220
    });

    const req = https.request({
      hostname: 'api.featherless.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`Featherless HTTP ${res.statusCode}`));
          return;
        }

        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (err) {
          reject(new Error(`Featherless parse failed: ${err.message}`));
          return;
        }

        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
        const msg = choice && choice.message ? choice.message : {};
        const text = String(msg.content || msg.reasoning || '').trim();
        if (!text) {
          reject(new Error('Featherless returned empty response text'));
          return;
        }

        resolve({ text, raw: parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runCouncilRoleFastPath(spec, problem, timeoutMs) {
  const featherless = resolveFeatherlessConfig();
  if (!featherless || !featherless.apiKey) {
    return { ok: false, error: 'Featherless config unavailable' };
  }

  const modelCandidates = COUNCIL_ROLE_MODEL_PRESETS[spec.id] || [];
  const configuredModel = String((featherless.defaultModelRef || '').split('/').slice(1).join('/') || '').trim();
  const available = new Set(featherless.models || []);
  const candidateList = [];

  for (const model of modelCandidates) candidateList.push(model);
  if (configuredModel) candidateList.push(configuredModel);

  const deduped = Array.from(new Set(candidateList)).filter((model) => !available.size || available.has(model));
  const maxModelsPerRole = Math.max(1, Math.min(3, Number(process.env.COUNCIL_MAX_MODELS_PER_ROLE || 1)));
  const models = (deduped.length ? deduped : modelCandidates).slice(0, maxModelsPerRole);
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs || 0));

  const prompt = [
    `Role: ${spec.role}`,
    `Goal: ${spec.goal}`,
    'You are one member in an AI Agents Council.',
    'Decide quickly and return strict compact JSON only.',
    'Keep recommendation <= 80 chars and rationale <= 160 chars.',
    'Actions must contain at most 2 short items.',
    '',
    'Problem:',
    problem,
    '',
    'JSON schema:',
    '{"agent":"researcher|security|coder|reviewer|notifier","vote":"approve|reject|needs-human","recommendation":"<=80 chars","rationale":"<=160 chars","actions":["<=2 actions"]}'
  ].join('\n');

  let lastError = 'Featherless request failed';
  let lastModel = '';
  for (const model of models) {
    const remainingBeforeCall = deadline - Date.now();
    if (remainingBeforeCall < 1200) {
      lastError = 'role time budget exhausted';
      break;
    }

    try {
      lastModel = model;
      const completion = await requestFeatherlessChat({
        apiKey: featherless.apiKey,
        model,
        timeoutMs: Math.max(1200, Math.min(3500, remainingBeforeCall - 300)),
        messages: [
          { role: 'system', content: 'Return strict JSON only. No markdown.' },
          { role: 'user', content: prompt }
        ]
      });
      const firstText = String(completion.text || '').trim();
      try {
        JSON.parse(extractJsonObject(firstText));
        return { ok: true, text: firstText, model };
      } catch {
        // One quick retry with stricter guardrails for JSON compliance.
        const remainingForRetry = deadline - Date.now();
        if (remainingForRetry < 1200) {
          return { ok: true, text: firstText, model };
        }

        const retryPrompt = [
          `Role: ${spec.role}`,
          `Goal: ${spec.goal}`,
          'Return ONLY one valid minified JSON object.',
          'No markdown, no commentary, no backticks.',
          'recommendation <= 80 chars, rationale <= 160 chars, actions <= 2.',
          '',
          `Issue: ${problem}`,
          '',
          'Schema:',
          '{"agent":"researcher|security|coder|reviewer|notifier","vote":"approve|reject|needs-human","recommendation":"string","rationale":"string","actions":["string"]}'
        ].join('\n');
        const retry = await requestFeatherlessChat({
          apiKey: featherless.apiKey,
          model,
          timeoutMs: Math.max(1200, Math.min(2500, remainingForRetry - 200)),
          messages: [
            { role: 'system', content: 'JSON only. Single object.' },
            { role: 'user', content: retryPrompt }
          ]
        });
        const retryText = String(retry.text || '').trim();
        return { ok: true, text: retryText || firstText, model };
      }
    } catch (err) {
      lastError = err.message || 'Featherless request failed';
    }
  }

  return { ok: false, error: lastError, model: lastModel || undefined };
}

async function runAgentsCouncil(problem) {
  const councilStartedAt = Date.now();
  const specs = [
    {
      id: 'researcher',
      role: 'Researcher',
      goal: 'Find the probable root cause and supporting evidence.'
    },
    {
      id: 'security',
      role: 'Security',
      goal: 'Identify security risks, abuse paths, and required safeguards.'
    },
    {
      id: 'coder',
      role: 'Coder',
      goal: 'Propose concrete implementation fix steps.'
    },
    {
      id: 'reviewer',
      role: 'Reviewer',
      goal: 'Assess quality, test coverage, and rollout confidence.'
    },
    {
      id: 'notifier',
      role: 'Notifier',
      goal: 'Summarize stakeholder communication and incident updates.'
    }
  ];

  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

  const runWithConcurrency = async (items, limit, worker) => {
    const results = new Array(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        results[index] = await worker(items[index], index);
      }
    });

    await Promise.all(runners);
    return results;
  };

  const roleConcurrency = Math.max(1, Math.min(4, Number(process.env.COUNCIL_ROLE_CONCURRENCY || 3)));
  const roleTimeoutMs = Math.max(2500, Math.min(15000, Number(process.env.COUNCIL_ROLE_TIMEOUT_MS || 6000)));
  const useGatewayFallback = String(process.env.COUNCIL_GATEWAY_FALLBACK || '0') === '1';

  const results = await runWithConcurrency(specs, roleConcurrency, async (spec) => {
    const roleStartedAt = Date.now();
    const finalize = (payload) => ({
      ...payload,
      latencyMs: Date.now() - roleStartedAt
    });

    const fast = await runCouncilRoleFastPath(spec, problem, roleTimeoutMs);
    if (fast.ok) {
      const parsed = parseCouncilAgentReply(fast.text, spec.id);
      parsed.model = fast.model;
      parsed.engine = 'featherless-direct';
      return finalize(parsed);
    }

    if (!useGatewayFallback) {
      return finalize({
        agent: spec.id,
        vote: 'needs-human',
        recommendation: `Council agent failed: ${fast.error || 'fast-path failure'}`,
        rationale: 'Escalating due to direct model failure.',
        actions: [],
        model: fast.model || 'n/a',
        engine: 'featherless-direct'
      });
    }

    const gatewayPrompt = [
      `You are ${spec.role} in an AI Agents Council.`,
      `Goal: ${spec.goal}`,
      'Return strict JSON only.',
      '',
      'Problem:',
      problem,
      '',
      'JSON schema:',
      '{"agent":"researcher|security|coder|reviewer|notifier","vote":"approve|reject|needs-human","recommendation":"short","rationale":"short","actions":["a1","a2"]}'
    ].join('\n');

    let response;
    try {
      response = await withTimeout(proxyGatewayChat(gatewayPrompt, {
        session: `council:${spec.id}`,
        agent: 'main'
      }), 12000);
    } catch (err) {
      return finalize({
        agent: spec.id,
        vote: 'needs-human',
        recommendation: `Council agent failed: ${err.message || 'unknown error'}`,
        rationale: 'Escalating due to model call failure.',
        actions: [],
        engine: 'gateway-fallback'
      });
    }

    if (!response.ok) {
      return finalize({
        agent: spec.id,
        vote: 'needs-human',
        recommendation: `Council agent failed: ${response.error || 'unknown error'}`,
        rationale: 'Escalating due to model call failure.',
        actions: [],
        engine: 'gateway-fallback'
      });
    }

    const parsed = parseCouncilAgentReply(response.text || response.raw || '', spec.id);
    parsed.engine = 'gateway-fallback';
    return finalize(parsed);
  });

  const totalLatencyMs = Date.now() - councilStartedAt;
  const slowest = results.reduce((winner, item) => {
    if (!item || typeof item !== 'object') return winner;
    const current = Number(item.latencyMs || 0);
    if (!winner || current > winner.latencyMs) {
      return { agent: String(item.agent || ''), latencyMs: current };
    }
    return winner;
  }, null);

  const counts = {
    approve: results.filter((r) => r.vote === 'approve').length,
    reject: results.filter((r) => r.vote === 'reject').length,
    needsHuman: results.filter((r) => r.vote === 'needs-human').length
  };

  let decision = 'escalate-human';
  let summary = 'Conflict detected. Escalate to human reviewer.';

  if (counts.needsHuman > 0) {
    decision = 'escalate-human';
    summary = 'At least one agent requested human review.';
  } else if (counts.approve > counts.reject) {
    decision = 'auto-execute';
    summary = 'Majority approved. Decision can be executed automatically.';
  } else if (counts.reject > counts.approve) {
    decision = 'halt-and-escalate';
    summary = 'Majority rejected. Halt automation and escalate.';
  }

  return {
    ok: true,
    problem,
    votes: counts,
    decision,
    summary,
    strategy: useGatewayFallback ? 'featherless-direct-with-gateway-fallback' : 'featherless-direct-fast-fail',
    latencyMs: totalLatencyMs,
    slowestRole: slowest,
    agents: results,
    generatedAt: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && reqUrl.pathname === '/api/dashboard/config') {
    const cfg = readGithubWatchConfig();
    return sendJson(res, 200, {
      openclaw_base: cfg.openclaw_base || '127.0.0.1',
      openclaw_port: Number(cfg.openclaw_port || 18789),
      openclaw_model: cfg.openclaw_model || 'openclaw',
      openclaw_chat_paths: Array.isArray(cfg.openclaw_chat_paths) ? cfg.openclaw_chat_paths : ['/v1/chat/completions', '/api/v1/chat', '/api/chat', '/chat'],
      openclaw_http_token: cfg.openclaw_http_token || cfg.openclaw_ws_token || ''
    });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/github/repos') {
    const cfg = readGithubWatchConfig();
    const watched = dedupeRepos(cfg.repos);
    const discovered = await fetchGithubUserRepos(String(cfg.github_token || '').trim());
    const pool = dedupeRepos([...(cfg.repo_pool || []), ...watched, ...discovered]);
    const active = watched[0] || pool[0] || null;

    if (!Array.isArray(cfg.repo_pool) || cfg.repo_pool.length !== pool.length) {
      cfg.repo_pool = pool;
      writeGithubWatchConfig(cfg);
    }

    return sendJson(res, 200, {
      ok: true,
      activeRepo: active ? serializeRepo(active) : null,
      repos: pool.map(serializeRepo),
      discoveredCount: discovered.length
    });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/github/repo/select') {
    try {
      const rawBody = await readBody(req);
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      const picked = parseRepoFullName(parsed.repo || parsed.fullName || '');
      if (!picked) {
        return sendJson(res, 400, { ok: false, error: 'repo must be in owner/repo format' });
      }

      const cfg = readGithubWatchConfig();
      const watched = dedupeRepos(cfg.repos);
      const pool = dedupeRepos([...(cfg.repo_pool || []), ...watched]);

      const key = `${picked.owner}/${picked.repo}`.toLowerCase();
      let selected = pool.find((item) => `${item.owner}/${item.repo}`.toLowerCase() === key);
      if (!selected) {
        selected = {
          owner: picked.owner,
          repo: picked.repo,
          actions: {
            new_issue: 'label it, post a welcome comment, flag if bug',
            new_pr: 'summarize changes, post review request'
          }
        };
        pool.push(selected);
      }

      cfg.repo_pool = dedupeRepos(pool);
      cfg.repos = [selected];
      writeGithubWatchConfig(cfg);

      return sendJson(res, 200, {
        ok: true,
        activeRepo: serializeRepo(selected),
        repos: cfg.repo_pool.map(serializeRepo),
        message: `Now monitoring ${selected.owner}/${selected.repo}`
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'failed to update repo selection' });
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/openclaw/chat') {
    try {
      const rawBody = await readBody(req);
      let parsed = {};
      try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsed = {};
      }

      const message = String(parsed.message || parsed.prompt || parsed.input || '').trim();
      if (!message) {
        return sendJson(res, 400, { ok: false, error: 'message is required' });
      }

      const proxied = await proxyGlobalChat(message);
      if (!proxied.ok) {
        return sendJson(res, 502, { ok: false, error: proxied.error || 'gateway request failed' });
      }

      return sendJson(res, 200, {
        ok: true,
        via: proxied.via,
        message: proxied.text,
        raw: proxied.raw
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'proxy error' });
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/agents-council/run') {
    try {
      const rawBody = await readBody(req);
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      const problem = String(parsed.problem || parsed.message || '').trim();
      if (!problem) {
        return sendJson(res, 400, { ok: false, error: 'problem is required' });
      }

      const result = await runAgentsCouncil(problem);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'agents council failed' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const filePath = safeResolveDashboardPath(reqUrl.pathname);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found');
      return;
    }

    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-store'
    });

    if (req.method === 'HEAD') {
      res.end();
      stream.destroy();
      return;
    }

    stream.pipe(res);
  });
});

server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`Dashboard server running at http://127.0.0.1:${DASHBOARD_PORT}`);
});
