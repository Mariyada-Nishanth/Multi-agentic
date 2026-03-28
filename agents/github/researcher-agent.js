const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config/github-watch.json');
const WATCHER_STATE_PATH = path.join(__dirname, '../../watcher-state.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadWatcherState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WATCHER_STATE_PATH, 'utf8'));
    return {
      seenIssues: Array.isArray(parsed.seenIssues) ? parsed.seenIssues.length : 0,
      seenPRs: Array.isArray(parsed.seenPRs) ? parsed.seenPRs.length : 0,
      seenCommits: Array.isArray(parsed.seenCommits) ? parsed.seenCommits.length : 0,
      reviewedPRs: Array.isArray(parsed.reviewedPRs) ? parsed.reviewedPRs.length : 0
    };
  } catch {
    return {
      seenIssues: 0,
      seenPRs: 0,
      seenCommits: 0,
      reviewedPRs: 0
    };
  }
}

function logHeartbeat() {
  const state = loadWatcherState();
  console.log(
    `researcher heartbeat issues=${state.seenIssues} prs=${state.seenPRs} commits=${state.seenCommits} reviewed_prs=${state.reviewedPRs}`
  );
}

function run() {
  const config = loadConfig();
  const intervalMs = Number(config.researcher_agent_heartbeat_ms || 30000);

  console.log('researcher-agent started; monitoring GitHub watcher state and ready for analysis tasks');
  logHeartbeat();

  const timer = setInterval(logHeartbeat, intervalMs);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('researcher-agent stopping');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(timer);
    console.log('researcher-agent stopping');
    process.exit(0);
  });
}

run();
