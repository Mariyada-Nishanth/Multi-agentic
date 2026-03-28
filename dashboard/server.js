const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8080);
const GITHUB_WATCH_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'github-watch.json');

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

async function proxyGlobalChat(message) {
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
            session: 'dashboard',
            agent: 'main'
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
