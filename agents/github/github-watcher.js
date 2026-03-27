const fs = require('fs');
const https = require('https');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../config/github-watch.json'), 'utf8')
);
const STATE_FILE = './watcher-state.json';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seenIssues: [], seenPRs: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function githubRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'Authorization': `Bearer ${config.github_token}`,
        'User-Agent': 'openclaw-watcher',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function postComment(owner, repo, number, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ body });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues/${number}/comments`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.github_token}`,
        'User-Agent': 'openclaw-watcher',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function addLabel(owner, repo, number, labels) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ labels });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues/${number}/labels`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.github_token}`,
        'User-Agent': 'openclaw-watcher',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function classifyIssue(title, body) {
  const text = (title + ' ' + (body || '')).toLowerCase();
  if (text.match(/bug|error|crash|fix|broken|fail/))
    return { label: 'bug', urgent: true };
  if (text.match(/feature|enhancement|add|improve/))
    return { label: 'enhancement', urgent: false };
  if (text.match(/question|how|help|why/))
    return { label: 'question', urgent: false };
  return { label: 'triage', urgent: false };
}

async function checkRepo(repo) {
  const state = loadState();
  const { owner, repo: repoName } = repo;
  console.log(`\n[${new Date().toISOString()}] Checking ${owner}/${repoName}...`);

  const issues = await githubRequest(
    `/repos/${owner}/${repoName}/issues?state=open&sort=created&direction=desc`
  );

  for (const issue of issues) {
    if (issue.pull_request) continue;
    if (state.seenIssues.includes(issue.number)) continue;

    console.log(`  NEW ISSUE #${issue.number}: ${issue.title}`);
    const { label, urgent } = classifyIssue(issue.title, issue.body);

    try {
      await addLabel(owner, repoName, issue.number, [label]);
      console.log(`  Ã¢â€ â€™ Labeled: ${label}`);
    } catch (e) {
      console.log(`  Ã¢â€ â€™ Could not add label (create it on GitHub first): ${label}`);
    }

    const comment = urgent
      ? `Ã°Å¸Å¡Â¨ This looks like a **bug** Ã¢â‚¬â€ flagging as urgent!\n\nWe'll look into it ASAP.\n\n*Posted by OpenClaw Watcher Ã°Å¸Â¦Å¾*`
      : `Ã°Å¸â€˜â€¹ Thanks for opening this! Labeled as **${label}**. We'll review it soon.\n\n*Posted by OpenClaw Watcher Ã°Å¸Â¦Å¾*`;

    await postComment(owner, repoName, issue.number, comment);
    console.log(`  Ã¢â€ â€™ Comment posted`);
    if (urgent) console.log(`  Ã¢Å¡Â Ã¯Â¸Â  URGENT BUG: #${issue.number} - ${issue.title}`);

    state.seenIssues.push(issue.number);
    saveState(state);
  }

  const prs = await githubRequest(
    `/repos/${owner}/${repoName}/pulls?state=open&sort=created&direction=desc`
  );

  for (const pr of prs) {
    if (state.seenPRs.includes(pr.number)) continue;

    console.log(`  NEW PR #${pr.number}: ${pr.title}`);
    await postComment(owner, repoName, pr.number,
      `Ã°Å¸â€˜â‚¬ New PR: **${pr.title}**\nReview requested!\n\n*Posted by OpenClaw Watcher Ã°Å¸Â¦Å¾*`
    );
    console.log(`  Ã¢â€ â€™ PR comment posted`);

    state.seenPRs.push(pr.number);
    saveState(state);
  }

  console.log(`  Ã¢Å“â€œ Done`);
}

async function run() {
  for (const repo of config.repos) {
    try {
      await checkRepo(repo);
    } catch (e) {
      console.error(`Error checking repo:`, e.message);
    }
  }
}

run();
setInterval(run, 5 * 60 * 1000);
console.log('Ã°Å¸Â¦Å¾ GitHub Watcher started Ã¢â‚¬â€ checking every 5 minutes');