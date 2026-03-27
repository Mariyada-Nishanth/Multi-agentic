const https = require('https');

const OPENCLAW_WS_TOKEN = '201ab2e994d0ded9a07c32d90b2364b57a67ef4d840f81d0';
const OPENCLAW_BASE = '127.0.0.1';
const OPENCLAW_PORT = 18789;
const GITHUB_TOKEN = require('../../config/github-watch.json').github_token;

function askOpenClaw(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: prompt,
      session: 'researcher',
      agent: 'main'
    });
    const options = {
      hostname: OPENCLAW_BASE,
      port: OPENCLAW_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_WS_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ text: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

async function researchAndComment(issue) {
  console.log(`  [OpenClaw] Sending issue #${issue.number} to gateway...`);

  const prompt = `
NEW BUG REPORTED on vamshi2196/WAFFLE:
Issue #${issue.number}: ${issue.title}
Description: ${issue.body || 'No description'}

Research this bug. Find the likely cause and solution.
Reply ONLY with this JSON (no extra text):
{
  "action": "comment",
  "issue_number": ${issue.number},
  "repo": "vamshi2196/WAFFLE",
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
        const fullComment = `## ðŸ¤– OpenClaw Research Agent\n\n${action.comment}\n\n---\n*Analyzed through OpenClaw gateway with full context + memory ðŸ¦ž*`;
        await postGitHubComment('vamshi2196', 'WAFFLE', issue.number, fullComment);
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

module.exports = { researchAndComment };