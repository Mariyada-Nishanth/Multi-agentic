const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const { interpretIntent } = require('./machines/oracle');
const { scanFlights } = require('./machines/sentinel');
const { checkForecast } = require('./machines/weather');
const { checkSafetyAndBudget } = require('./machines/guardian');
const { pickBestValue } = require('./machines/optimizer');
const { negotiatePlan, completeAndShare } = require('./machines/negotiator');

const CONFIG_PATH = path.join(__dirname, '../../config/travel-watch.json');
const STATE_FILE = path.join(__dirname, '../../travel-state.json');
const RESPONSE_FILE = path.join(__dirname, '../../dashboard/travel-response.json');

const promptQueue = [];
let lastRun = null;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Missing config/travel-watch.json. Copy from config/travel-watch.example.json and fill keys.');
  }
  return readJson(CONFIG_PATH, {});
}

function loadState() {
  return readJson(STATE_FILE, { processedPromptIds: [] });
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function looksLikeTravelTrigger(text) {
  return /plan\s+.+trip|travel\s+plan|trip\s+to|goa/i.test(text || '');
}

function formatDateTime(isoText) {
  if (!isoText) return 'TBD';
  const dt = new Date(isoText);
  if (Number.isNaN(dt.getTime())) return 'TBD';

  return dt.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function respondJson(res, status, payload) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startPromptApiServer(config) {
  const port = Number(config.prompt_api_port || 18890);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);

    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      respondJson(res, 200, {
        ok: true,
        queueDepth: promptQueue.length,
        lastRun
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/travel/last') {
      respondJson(res, 200, {
        ok: true,
        lastRun
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/travel/prompt') {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const prompt = String(parsed.prompt || '').trim();

        if (!prompt) {
          respondJson(res, 400, { ok: false, error: 'Prompt is required' });
          return;
        }

        const id = `${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        promptQueue.push({ id, prompt, source: 'dashboard', createdAt: new Date().toISOString() });
        respondJson(res, 202, { ok: true, id, queued: true });
      } catch (err) {
        respondJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    respondJson(res, 404, { ok: false, error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`success travel prompt API started at http://127.0.0.1:${port}`);
  });
}

function formatReply(intent, guardianResult, weatherResult, plan, completion) {
  const selectedFlight = plan.selected && plan.selected.flight;
  const selectedHotel = plan.selected && plan.selected.hotel;
  const flightSummary = selectedFlight
    ? `${selectedFlight.airline} ${selectedFlight.flightCode} | fare INR ${selectedFlight.estimatedFareInr}`
    : 'none';
  const departureText = selectedFlight ? formatDateTime(selectedFlight.departureTime) : 'TBD';
  const arrivalText = selectedFlight ? formatDateTime(selectedFlight.arrivalTime) : 'TBD';
  const hotelSummary = selectedHotel
    ? `${selectedHotel.name} | nightly INR ${selectedHotel.nightlyInr}`
    : 'none';
  const lines = [
    'Feature 6 - Autonomous travel concierge',
    '',
    `Trigger captured: ${intent.rawText || 'N/A'}`,
    `Destination: ${intent.destination}`,
    `Dates: ${intent.travelDates.from || 'TBD'} to ${intent.travelDates.to || 'TBD'}`,
    `Group size: ${intent.groupSize}`,
    `Budget: INR ${intent.budgetInr}`,
    '',
    'Machine outputs:',
    `ORACLE: intent parsed with preferences [${intent.preferences.join(', ')}]`,
    `SENTINEL: best flight ${selectedFlight ? `${selectedFlight.airline} ${selectedFlight.flightCode}` : 'none'}`,
    `WEATHER: ${weatherResult.summary} (risk: ${weatherResult.riskLevel})`,
    `GUARDIAN: ${guardianResult.safeToProceed ? 'safe to proceed' : 'review required'}`,
    `OPTIMIZER: hotel option ${selectedHotel ? selectedHotel.name : 'none'}`,
    '',
    'Agent negotiation round:',
    ...plan.tradeoffNotes.map((n) => `- ${n}`),
    '',
    'Completion:',
    `${completion.booking.status} with booking id ${completion.booking.bookingId}`,
    `Flight: ${flightSummary}`,
    `Departure: ${departureText}`,
    `Arrival: ${arrivalText}`,
    `Hotel: ${hotelSummary}`,
    completion.sharePayload.summary,
    '',
    'Advisories:',
    ...(plan.advisories.length ? plan.advisories.map((n) => `- ${n}`) : ['- none'])
  ];

  return lines.join('\n');
}

async function processPrompt(config, promptJob) {
  const text = promptJob.prompt || '';
  if (!looksLikeTravelTrigger(text)) {
    console.log('warn prompt did not match travel trigger pattern; processing anyway');
  }

  console.log(`started trigger processing for prompt ${promptJob.id}`);
  const defaults = config.defaults || {};
  const intent = interpretIntent(text, defaults);
  console.log(`success ORACLE interprets intent destination=${intent.destination} budget=${intent.budgetInr}`);

  const sentinelResult = await scanFlights(intent, config);
  console.log(`success SENTINEL scans flights count=${sentinelResult.flights.length}`);

  const weatherResult = await checkForecast(intent, config);
  console.log(`success WEATHER forecast check ${weatherResult.summary}`);

  const guardianResult = checkSafetyAndBudget(intent, sentinelResult, weatherResult, config);
  console.log(`warn GUARDIAN checks budget safeToProceed=${guardianResult.safeToProceed}`);

  const optimizerResult = pickBestValue(intent, sentinelResult, config);
  console.log(`success OPTIMIZER picks options flights=${optimizerResult.rankedFlights.length}`);

  const plan = negotiatePlan(intent, optimizerResult, guardianResult, weatherResult, config);
  console.log('info Agent negotiation round complete');

  const completion = completeAndShare(plan, intent);
  console.log(`success Complete itinerary auto-booked and shared booking=${completion.booking.bookingId}`);

  const reply = formatReply(intent, guardianResult, weatherResult, plan, completion);
  lastRun = {
    id: promptJob.id,
    prompt: text,
    status: 'completed',
    completedAt: new Date().toISOString(),
    output: reply
  };
  writeJson(RESPONSE_FILE, lastRun);
  console.log('posted itinerary summary to dashboard response file');
}

async function processQueue(config, state) {
  if (!promptQueue.length) return;
  const next = promptQueue.shift();
  if (!next) return;
  if (state.processedPromptIds.includes(next.id)) return;

  try {
    await processPrompt(config, next);
    state.processedPromptIds.push(next.id);
    if (state.processedPromptIds.length > 1000) {
      state.processedPromptIds = state.processedPromptIds.slice(-1000);
    }
  } catch (err) {
    console.error(`error trigger execution failed: ${err.message}`);
    lastRun = {
      id: next.id,
      prompt: next.prompt,
      status: 'failed',
      completedAt: new Date().toISOString(),
      output: err.message
    };
    writeJson(RESPONSE_FILE, lastRun);
  }
  saveState(state);
}

async function run() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`error ${err.message}`);
    return;
  }

  const state = loadState();
  startPromptApiServer(config);
  console.log('success travel-concierge waiting for website prompts');

  while (true) {
    try {
      await processQueue(config, state);
      const cooldownMs = Number(config.poll_interval_ms || 4000);
      await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    } catch (err) {
      console.error(`error poll cycle failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
}

run();
