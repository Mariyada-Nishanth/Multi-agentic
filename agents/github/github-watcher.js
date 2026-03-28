const fs = require('fs');
const https = require('https');
const path = require('path');
const { researchAndComment, askOpenClaw } = require('./openclaw-researcher');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../config/github-watch.json'), 'utf8')
);
const STATE_FILE = './watcher-state.json';

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(parsed.seenIssues)) parsed.seenIssues = [];
    if (!Array.isArray(parsed.seenPRs)) parsed.seenPRs = [];
    if (!Array.isArray(parsed.seenCommits)) parsed.seenCommits = [];
    if (!Array.isArray(parsed.reviewedPRs)) parsed.reviewedPRs = [];
    if (!parsed.reviewedPRHeads || typeof parsed.reviewedPRHeads !== 'object') {
      parsed.reviewedPRHeads = {};
    }
    return parsed;
  } catch {
    return { seenIssues: [], seenPRs: [], seenCommits: [], reviewedPRs: [], reviewedPRHeads: {} };
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

function postCommitComment(owner, repo, sha, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ body });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/commits/${sha}/comments`,
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

async function analyzeCommitWithOpenClaw(owner, repoName, commit) {
  const sha = commit.sha;
  const details = await githubRequest(`/repos/${owner}/${repoName}/commits/${sha}`);
  const files = Array.isArray(details.files) ? details.files : [];
  const maxFiles = Number(config.commit_review_max_files || 5);
  const maxPatchChars = Number(config.commit_review_max_patch_chars || 2000);

  const patchSummary = files.slice(0, maxFiles).map((file) => {
    const patch = (file.patch || '').slice(0, maxPatchChars);
    return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${patch || '[no patch data]'}\n`;
  }).join('\n');

  const prompt = `
COMMIT REVIEW for ${owner}/${repoName}
SHA: ${sha}
Message: ${details.commit && details.commit.message}
Author: ${details.commit && details.commit.author && details.commit.author.name}

Diff summary:\n${patchSummary}

Analyze this commit for potential bugs, risks, or missing tests. Provide fixes or suggestions.
Reply ONLY with JSON:
{
  "summary": "short summary",
  "risks": ["risk1", "risk2"],
  "suggested_fixes": ["fix1", "fix2"]
}
`.trim();

  const response = await askOpenClaw(prompt);
  const text = response.text || response.message || JSON.stringify(response);
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      summary: 'Unable to parse OpenClaw response.',
      risks: [],
      suggested_fixes: []
    };
  }

  return JSON.parse(jsonMatch[0]);
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

async function analyzePullRequestWithOpenClaw(owner, repoName, prNumber) {
  const pr = await githubRequest(`/repos/${owner}/${repoName}/pulls/${prNumber}`);
  const files = await githubRequest(`/repos/${owner}/${repoName}/pulls/${prNumber}/files`);
  const maxFiles = Number(config.pr_review_max_files || 6);
  const maxPatchChars = Number(config.pr_review_max_patch_chars || 2000);

  const patchSummary = (Array.isArray(files) ? files : []).slice(0, maxFiles).map((file) => {
    const patch = (file.patch || '').slice(0, maxPatchChars);
    return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${patch || '[no patch data]'}\n`;
  }).join('\n');

  const prompt = `
PR REVIEW for ${owner}/${repoName}
PR #${prNumber}: ${pr.title}
Author: ${pr.user && pr.user.login}
Base: ${pr.base && pr.base.ref} -> Head: ${pr.head && pr.head.ref}

Diff summary:\n${patchSummary}

Analyze the PR for bugs, risks, missing tests, and suggest fixes. Reply ONLY with JSON:
{
  "summary": "short summary",
  "risks": ["risk1", "risk2"],
  "suggested_fixes": ["fix1", "fix2"],
  "tests": ["test1", "test2"]
}
`.trim();

  const response = await askOpenClaw(prompt);
  const text = response.text || response.message || JSON.stringify(response);
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      summary: 'Unable to parse OpenClaw response.',
      risks: [],
      suggested_fixes: [],
      tests: []
    };
  }

  return JSON.parse(jsonMatch[0]);
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
      console.log(`  Labeled: ${label}`);
    } catch (e) {
      console.log(`  Could not add label (create it on GitHub first): ${label}`);
    }

    const comment = urgent
      ? `This looks like a **bug** - flagging as urgent.\n\nWe will look into it as soon as possible.\n\nPosted by OpenClaw Watcher.`
      : `Thanks for opening this. Labeled as **${label}**. We will review it soon.\n\nPosted by OpenClaw Watcher.`;

    await postComment(owner, repoName, issue.number, comment);
    console.log(`  Comment posted`);
    if (urgent) console.log(`  URGENT BUG: #${issue.number} - ${issue.title}`);

    if (urgent && config.issue_research_enabled) {
      await researchAndComment(issue, owner, repoName);
    }

    state.seenIssues.push(issue.number);
    saveState(state);
  }

  const prs = await githubRequest(
    `/repos/${owner}/${repoName}/pulls?state=open&sort=created&direction=desc`
  );

  for (const pr of prs) {
    const headSha = pr.head && pr.head.sha;
    const isNewPr = !state.seenPRs.includes(pr.number);
    const lastReviewedSha = state.reviewedPRHeads[String(pr.number)];
    const hasNewCommit = headSha && headSha !== lastReviewedSha;

    if (!isNewPr && !hasNewCommit) {
      continue;
    }

    if (isNewPr) {
      console.log(`  NEW PR #${pr.number}: ${pr.title}`);
      await postComment(owner, repoName, pr.number,
        `New PR: **${pr.title}**\nReview requested.\n\nPosted by OpenClaw Watcher.`
      );
      console.log(`  PR comment posted`);
    } else if (hasNewCommit) {
      console.log(`  PR UPDATE #${pr.number}: new commit detected (${headSha.slice(0, 7)})`);
    }

    if (config.pr_review_enabled) {
      try {
        const review = await analyzePullRequestWithOpenClaw(owner, repoName, pr.number);
        const body = `## OpenClaw PR Review\n\n**Summary**\n${review.summary || 'N/A'}\n\n**Risks**\n${(review.risks || []).map((r) => `- ${r}`).join('\n') || '- none'}\n\n**Suggested fixes**\n${(review.suggested_fixes || []).map((f) => `- ${f}`).join('\n') || '- none'}\n\n**Tests to consider**\n${(review.tests || []).map((t) => `- ${t}`).join('\n') || '- none'}\n\n**Head commit**\n${headSha || 'unknown'}\n\n---\nAutomated PR review via OpenClaw gateway.`;
        await postComment(owner, repoName, pr.number, body);
        console.log(`  PR review posted for #${pr.number}`);
      } catch (err) {
        console.log(`  PR review failed: ${err.message}`);
      }

      state.reviewedPRs.push(pr.number);
      if (state.reviewedPRs.length > 200) {
        state.reviewedPRs = state.reviewedPRs.slice(-200);
      }
    }

    state.reviewedPRHeads[String(pr.number)] = headSha || lastReviewedSha || null;
    if (isNewPr) state.seenPRs.push(pr.number);
    saveState(state);
  }

  if (config.commit_review_enabled) {
    const commits = await githubRequest(
      `/repos/${owner}/${repoName}/commits?per_page=${Number(config.commit_review_per_page || 5)}`
    );

    for (const commit of commits) {
      if (state.seenCommits.includes(commit.sha)) continue;
      console.log(`  NEW COMMIT ${commit.sha.slice(0, 7)}: ${commit.commit && commit.commit.message}`);

      try {
        const review = await analyzeCommitWithOpenClaw(owner, repoName, commit);
        const body = `## OpenClaw Commit Review\n\n**Summary**\n${review.summary || 'N/A'}\n\n**Risks**\n${(review.risks || []).map((r) => `- ${r}`).join('\n') || '- none'}\n\n**Suggested fixes**\n${(review.suggested_fixes || []).map((f) => `- ${f}`).join('\n') || '- none'}\n\n---\nAutomated review via OpenClaw gateway.`;
        await postCommitComment(owner, repoName, commit.sha, body);
        console.log(`  Commit review posted for ${commit.sha.slice(0, 7)}`);
      } catch (err) {
        console.log(`  Commit review failed: ${err.message}`);
      }

      state.seenCommits.push(commit.sha);
      if (state.seenCommits.length > 200) {
        state.seenCommits = state.seenCommits.slice(-200);
      }
      saveState(state);
    }
  }

  console.log(`  Done`);
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
console.log('GitHub Watcher started - checking every 5 minutes');