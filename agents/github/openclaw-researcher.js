const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../../config/github-watch.json');
const OPENCLAW_WS_TOKEN = config.openclaw_ws_token || '201ab2e994d0ded9a07c32d90b2364b57a67ef4d840f81d0';
const OPENCLAW_HTTP_TOKEN = config.openclaw_http_token || OPENCLAW_WS_TOKEN;
const OPENCLAW_DEVICE_TOKEN = config.openclaw_device_token || '';
const OPENCLAW_DEVICE_IDENTITY_PATH = config.openclaw_device_identity_path
  || path.join(__dirname, '..', '..', 'config', 'openclaw-device-identity.json');
const OPENCLAW_BASE = config.openclaw_base || '127.0.0.1';
const OPENCLAW_PORT = Number(config.openclaw_port || 18789);
const OPENCLAW_WS_URL = config.openclaw_ws_url || `ws://${OPENCLAW_BASE}:${OPENCLAW_PORT}/`;
const OPENCLAW_SESSION_KEY = config.openclaw_session_key || 'agent:main:main';
const OPENCLAW_WS_TIMEOUT_MS = Number(config.openclaw_ws_timeout_ms || 20000);
const OPENCLAW_CHAT_PATHS = Array.isArray(config.openclaw_chat_paths)
  ? config.openclaw_chat_paths
  : ['/v1/chat/completions', '/api/v1/chat', '/api/chat', '/chat'];
const OPENCLAW_MODEL = config.openclaw_model || 'openclaw';
const OPENCLAW_WS_DEBUG = config.openclaw_ws_debug === true || process.env.OPENCLAW_WS_DEBUG === '1';
const GITHUB_TOKEN = config.github_token;

function wsDebugLog(...parts) {
  if (!OPENCLAW_WS_DEBUG) return;
  console.log('[OpenClaw WS DEBUG]', ...parts);
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(base64, 'base64');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readDeviceIdentity() {
  try {
    if (!fs.existsSync(OPENCLAW_DEVICE_IDENTITY_PATH)) return null;
    const raw = fs.readFileSync(OPENCLAW_DEVICE_IDENTITY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.deviceId !== 'string') return null;
    if (typeof parsed.publicKeyPem === 'string' && typeof parsed.privateKeyPem === 'string') {
      let publicKey = parsed.publicKey;
      if (!publicKey) {
        try {
          const key = crypto.createPublicKey(parsed.publicKeyPem);
          let rawKey;
          try {
            rawKey = key.export({ format: 'raw' });
          } catch {
            const der = key.export({ format: 'der', type: 'spki' });
            rawKey = der.slice(-32);
          }
          publicKey = toBase64Url(rawKey);
        } catch {
          publicKey = '';
        }
      }
      return {
        deviceId: parsed.deviceId,
        publicKey,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem
      };
    }
    if (typeof parsed.publicKey !== 'string') return null;
    if (typeof parsed.privateKey !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDeviceIdentity(identity) {
  const dir = path.dirname(OPENCLAW_DEVICE_IDENTITY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    OPENCLAW_DEVICE_IDENTITY_PATH,
    JSON.stringify(identity, null, 2),
    'utf8'
  );
}

async function getOrCreateDeviceIdentity() {
  const existing = readDeviceIdentity();
  if (existing) return existing;

  return null;
}

function buildDeviceSignaturePayload({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce
}) {
  return [
    'v2',
    deviceId,
    clientId,
    clientMode,
    role,
    Array.isArray(scopes) ? scopes.join(',') : '',
    String(signedAtMs),
    token || '',
    nonce || ''
  ].join('|');
}

async function buildSignedDevicePayload({ nonce, clientId, clientMode, role, scopes, token }) {
  if (!nonce) return undefined;

  const identity = await getOrCreateDeviceIdentity();
  if (!identity) return undefined;

  const signedAt = Date.now();
  const payload = buildDeviceSignaturePayload({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs: signedAt,
    token,
    nonce: nonce || ''
  });

  let signature;
  if (identity.privateKeyPem) {
    const key = crypto.createPrivateKey(identity.privateKeyPem);
    signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  } else if (identity.privateKey) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return undefined;
    const subtle = globalThis.crypto.subtle;
    const privateKey = await subtle.importKey(
      'pkcs8',
      fromBase64Url(identity.privateKey),
      { name: 'Ed25519' },
      false,
      ['sign']
    );
    signature = Buffer.from(await subtle.sign(
      'Ed25519',
      privateKey,
      Buffer.from(payload, 'utf8')
    ));
  } else {
    return undefined;
  }

  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: toBase64Url(Buffer.from(signature)),
    signedAt,
    nonce: nonce || ''
  };
}

function buildOpenClawAuth(nonce = '') {
  const auth = {};
  if (OPENCLAW_WS_TOKEN) auth.token = OPENCLAW_WS_TOKEN;
  if (OPENCLAW_DEVICE_TOKEN) auth.deviceToken = OPENCLAW_DEVICE_TOKEN;
  if (nonce) auth.nonce = nonce;
  return Object.keys(auth).length ? auth : undefined;
}

function sendOpenClawRequest(path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      hostname: OPENCLAW_BASE,
      port: OPENCLAW_PORT,
      path,
      method: 'POST',
      headers
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseHttpChatResponse(path, responseBody) {
  try {
    const parsed = JSON.parse(responseBody);

    if (path === '/v1/chat/completions') {
      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      const content = choice && choice.message && choice.message.content;
      if (typeof content === 'string' && content.trim()) {
        return { text: content.trim(), raw: parsed };
      }
    }

    if (typeof parsed.text === 'string') return parsed;
    if (typeof parsed.message === 'string') return { text: parsed.message, raw: parsed };
    return { text: JSON.stringify(parsed), raw: parsed };
  } catch {
    return { text: responseBody };
  }
}

function shouldRetryAsPlainText(resultText) {
  const text = String(resultText || '').toLowerCase();
  return text.includes('failed to call a function') || text.includes('failed_generation');
}

function buildNoToolsPrompt(prompt) {
  return [
    'Reply with plain text only.',
    'Do not call functions, tools, or external actions.',
    'If JSON is requested, return raw JSON text only.',
    '',
    prompt
  ].join('\n');
}

async function askOpenClawHTTP(prompt) {
  const tryPaths = async (index, plainTextMode = false) => {
    if (index >= OPENCLAW_CHAT_PATHS.length) {
      return { text: 'OpenClaw chat endpoint not found.' };
    }

    const path = OPENCLAW_CHAT_PATHS[index];
    const effectivePrompt = plainTextMode ? buildNoToolsPrompt(prompt) : prompt;
    const body = path === '/v1/chat/completions'
      ? JSON.stringify({
        model: OPENCLAW_MODEL,
        messages: [{ role: 'user', content: effectivePrompt }]
      })
      : JSON.stringify({
        message: effectivePrompt,
        session: 'researcher',
        agent: 'main'
      });

    const response = await sendOpenClawRequest(path, body, OPENCLAW_HTTP_TOKEN);

    if (response.status === 404 || response.status === 405) {
      return tryPaths(index + 1, plainTextMode);
    }

    if (response.status >= 400) {
      return { text: `OpenClaw HTTP ${response.status}: ${response.body || 'request failed'}` };
    }

    const parsed = parseHttpChatResponse(path, response.body);
    if (!plainTextMode && shouldRetryAsPlainText(parsed && parsed.text)) {
      return tryPaths(index, true);
    }

    return parsed;
  };

  return tryPaths(0, false);
}

function askOpenClawWS(prompt) {
  if (typeof WebSocket === 'undefined') {
    return Promise.resolve({ text: 'WebSocket not available in this Node runtime.' });
  }

  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    return Promise.resolve({ text: 'WebCrypto not available in this Node runtime.' });
  }

  return new Promise((resolve) => {
    const messageId = crypto.randomUUID();
    const reqId = crypto.randomUUID();
    const ws = new WebSocket(OPENCLAW_WS_URL);

    let resolved = false;
    let lastText = '';
    let lastRaw = '';
    let chatSent = false;
    let challengeSeen = false;
    let challengeNonce = '';
    const connectRequests = new Map();

    wsDebugLog('starting askOpenClawWS', {
      wsUrl: OPENCLAW_WS_URL,
      hasGatewayToken: Boolean(OPENCLAW_WS_TOKEN),
      hasDeviceToken: Boolean(OPENCLAW_DEVICE_TOKEN),
      sessionKey: OPENCLAW_SESSION_KEY
    });

    function finish(result) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { ws.close(); } catch { }
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({ text: lastText || lastRaw || 'OpenClaw websocket timed out.' });
    }, OPENCLAW_WS_TIMEOUT_MS);

    function sendChat() {
      if (chatSent) return;
      chatSent = true;
      const payload = {
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          sessionKey: OPENCLAW_SESSION_KEY,
          message: prompt,
          deliver: true,
          idempotencyKey: messageId
        }
      };
      ws.send(JSON.stringify(payload));
    }

    async function sendConnect(nonce = '') {
      if (ws.readyState !== WebSocket.OPEN) return;

      const connectId = crypto.randomUUID();
      connectRequests.set(connectId, nonce);

      const client = {
        id: 'gateway-client',
        version: '1.0.0',
        platform: 'node',
        mode: 'backend'
      };

      const role = 'operator';
      const scopes = ['operator.admin', 'operator.read', 'operator.write'];
      const device = await buildSignedDevicePayload({
        nonce,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        token: OPENCLAW_WS_TOKEN
      });

      const payload = {
        type: 'req',
        id: connectId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client,
          role,
          scopes,
          caps: ['tool-events'],
          auth: buildOpenClawAuth(nonce),
          userAgent: 'node',
          locale: 'en-US',
          device
        }
      };
      wsDebugLog('send connect', {
        id: connectId,
        nonce: nonce || '(none)',
        role,
        scopes,
        hasAuth: Boolean(payload.params.auth),
        hasDevice: Boolean(payload.params.device)
      });
      ws.send(JSON.stringify(payload));
    }


    ws.onopen = () => {
      wsDebugLog('socket open');
      sendConnect().catch(() => {
        finish({ text: 'OpenClaw connect preparation failed.' });
      });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data) return;
        lastRaw = JSON.stringify(data);

        if (data.type === 'res') {
          wsDebugLog('recv res', {
            id: data.id,
            ok: data.ok,
            errorCode: data.error && data.error.code,
            errorMessage: data.error && data.error.message,
            errorDetailsCode: data.error && data.error.details && data.error.details.code
          });
        } else if (data.type === 'event') {
          wsDebugLog('recv event', {
            event: data.event,
            seq: data.seq,
            hasPayload: Boolean(data.payload)
          });
        }

        if (data.type === 'event' && data.event === 'connect.challenge') {
          const nonce = data.payload && data.payload.nonce;
          if (nonce && nonce !== challengeNonce) {
            challengeSeen = true;
            challengeNonce = nonce;
            wsDebugLog('challenge received', { nonce });
            sendConnect(nonce).catch(() => {
              finish({ text: 'OpenClaw challenge response failed.' });
            });
          }
          return;
        }

        if (data.type === 'res' && connectRequests.has(data.id)) {
          const requestNonce = connectRequests.get(data.id) || '';
          connectRequests.delete(data.id);

          if (data.ok === true) {
            if (challengeSeen && challengeNonce && requestNonce !== challengeNonce) {
              // Ignore the pre-challenge hello when a challenge has been issued.
              wsDebugLog('ignoring pre-challenge hello', { id: data.id, requestNonce });
              return;
            }
            wsDebugLog('connect accepted; sending chat', { id: data.id, requestNonce });
            sendChat();
            return;
          }

          if (challengeSeen && requestNonce === '') {
            // Ignore failed pre-challenge response once we have a challenge to answer.
            wsDebugLog('ignoring pre-challenge connect error after challenge', {
              id: data.id,
              error: data.error && data.error.message
            });
            return;
          }

          const msg = (data.error && (data.error.message || data.error.code)) || 'OpenClaw connect failed.';
          finish({ text: String(msg) });
          return;
        }

        if (data.type === 'res' && data.ok === false) {
          const msg = (data.error && (data.error.message || data.error.code)) || 'OpenClaw responded with error.';
          finish({ text: String(msg) });
          return;
        }

        if (data.type === 'res' && data.ok === true && data.payload && data.payload.status) {
          lastText = `OpenClaw status: ${data.payload.status}`;
        }

        if (data.type === 'event' && data.payload) {
          const payload = data.payload || {};
          const eventName = data.event || payload.event || payload.type || '';
          const messageObj = payload.message || payload.chat || payload.data || {};
          const candidates = [
            payload.text,
            payload.content,
            payload.output,
            messageObj.text,
            messageObj.content,
            messageObj.message
          ];
          const text = candidates.find((value) => typeof value === 'string' && value.trim());

          if (text) {
            lastText = text.trim();
            finish({ text: lastText, event: eventName || 'event' });
          } else if (!resolved && /^chat(\.|$)/.test(eventName) && lastRaw) {
            finish({ text: lastRaw, event: eventName });
          }
        }
      } catch {
      }
    };

    ws.onerror = () => {
      finish({ text: 'OpenClaw websocket error.' });
    };
  });
}

function askOpenClaw(prompt) {
  const useHttp = config.openclaw_http_enabled !== false;
  const useWs = config.openclaw_ws_enabled !== false;

  if (useHttp) {
    return askOpenClawHTTP(prompt).then((result) => {
      if (result && typeof result.text === 'string' && !/endpoint not found/i.test(result.text)) {
        return result;
      }

      if (useWs) {
        return askOpenClawWS(prompt);
      }

      return result;
    });
  }

  return askOpenClawWS(prompt);
}

function postGitHubComment(owner, repo, issueNumber, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ body });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'openclaw-researcher',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function researchAndComment(issue, owner, repo) {
  console.log(`  [OpenClaw] Sending issue #${issue.number} to gateway...`);

  const prompt = `
NEW BUG REPORTED on ${owner}/${repo}:
Issue #${issue.number}: ${issue.title}
Description: ${issue.body || 'No description'}

Research this bug. Find the likely cause and solution.
Reply ONLY with this JSON (no extra text):
{
  "action": "comment",
  "issue_number": ${issue.number},
  "repo": "${owner}/${repo}",
  "comment": "your full markdown analysis here"
}
`.trim();

  try {
    const response = await askOpenClaw(prompt);
    console.log(`  [OpenClaw] Got response from gateway`);

    // Parse the JSON from OpenClaw's reply
    const text = response.text || response.message || JSON.stringify(response);
    const jsonMatch = text.match(/\{[\s\S]*"action"[\s\S]*\}/);

    if (jsonMatch) {
      const action = JSON.parse(jsonMatch[0]);
      if (action.action === 'comment' && action.comment) {
        const fullComment = `## OpenClaw Research Agent\n\n${action.comment}\n\n---\nAnalyzed through OpenClaw gateway with full context and memory.`;
        await postGitHubComment(owner, repo, issue.number, fullComment);
        console.log(`  [OpenClaw] Research comment posted to issue #${issue.number}`);
      }
    } else {
      console.log(`  [OpenClaw] Could not parse action from response`);
      console.log(`  Raw response:`, text.slice(0, 200));
    }
  } catch (e) {
    console.log(`  [OpenClaw] Error: ${e.message}`);
  }
}

module.exports = { researchAndComment, askOpenClaw };