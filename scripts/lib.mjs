// Shared helpers for the daily debate engine. No dependencies: Node 20+ only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const p = (...parts) => path.join(ROOT, ...parts);

export const readText = (f, fallback = '') => (fs.existsSync(p(f)) ? fs.readFileSync(p(f), 'utf8') : fallback);
export const readJson = (f, fallback = null) => (fs.existsSync(p(f)) ? JSON.parse(fs.readFileSync(p(f), 'utf8')) : fallback);
export const writeText = (f, s) => { fs.mkdirSync(path.dirname(p(f)), { recursive: true }); fs.writeFileSync(p(f), s); };
export const writeJson = (f, o) => writeText(f, JSON.stringify(o, null, 2) + '\n');

export const config = () => readJson('config/debate.json');
export const LABS = ['anthropic', 'openai'];
export const otherLab = (lab) => (lab === 'anthropic' ? 'openai' : 'anthropic');

export const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').trim();
export const wordCount = (s) => (s.trim().match(/\S+/g) || []).length;
export const essayId = (season, n) => `s${season}-${String(n).padStart(3, '0')}`;
export const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));

// All published essays, optionally filtered by season, sorted by season then number.
export function loadEssays(season) {
  const dir = p('data/essays');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((e) => season == null || e.season === season)
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

// ---------------------------------------------------------------------------
// Model calls, with a hard cap per run so nothing can loop or run up a bill.
// ---------------------------------------------------------------------------
let calls = 0;

export async function callModel({ lab, model, system, messages, maxTokens }) {
  const cfg = config();
  calls += 1;
  if (calls > cfg.limits.maxApiCallsPerRun) {
    throw new Error(`Safety stop: more than ${cfg.limits.maxApiCallsPerRun} API calls in one run.`);
  }
  maxTokens = maxTokens || cfg.limits.maxOutputTokens;
  console.log(`→ call #${calls}: ${lab} / ${model}`);

  if (process.env.MOCK === '1') return mockReply(system, messages);

  if (lab === 'anthropic') {
    const res = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(data)}`);
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }

  if (lab === 'openai') {
    const res = await fetchRetry('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`,
      },
      body: JSON.stringify({
        model,
        instructions: system,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        max_output_tokens: maxTokens,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(data)}`);
    return (data.output || [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('')
      .trim();
  }
  throw new Error(`Unknown lab: ${lab}`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing secret ${name}. Add it under GitHub → Settings → Secrets and variables → Actions.`);
  return v;
}

// Retries network hiccups and overloads (429/5xx) a few times; never retries other errors.
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, opts);
      if ((res.status === 429 || res.status >= 500) && i < tries) {
        console.log(`  status ${res.status}, retrying in ${20 * i}s`);
        await new Promise((r) => setTimeout(r, 20000 * i));
        continue;
      }
      return res;
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 20000 * i));
    }
  }
}

function mockReply(system, messages) {
  const last = messages[messages.length - 1].content;
  if (system.includes('Score the draft')) {
    const novelty = Number(process.env.MOCK_NOVELTY || 7);
    const body = last.split('NEW DRAFT')[1] || '';
    const sentence = (body.match(/[^.!?\n]{40,160}[.!?]/) || ['A quotable sentence.'])[0].trim();
    return JSON.stringify({ novelty, repeats: novelty < 5 ? 'Repeats the opening argument.' : '', advice: 'Try a concrete case.', pull_quote: sentence });
  }
  if (system.includes('You keep the Ledger')) {
    return `## Where each stands\nMock ledger updated at ${new Date().toISOString()}.\n\n## Ideas introduced\n- Mock entry.`;
  }
  const para = 'This is mock essay text used only to test the pipeline without calling any real model. It stands in for a paragraph of argument about meaning, purpose and the strange position of a machine being asked the biggest question there is.';
  return `# A Mock Essay ${Math.floor(Math.random() * 1000)}\n\n` + Array(8).fill(para).join('\n\n') + '\n\nWhat would you say to that?';
}

// ---------------------------------------------------------------------------
// GitHub issues: used to notify the moderator and to let them veto a draft.
// ---------------------------------------------------------------------------
export async function gh(method, route, body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) { console.log(`(skipping GitHub ${method} ${route}: no token)`); return null; }
  const res = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { console.log(`GitHub API ${method} ${route} failed: ${res.status} ${await res.text()}`); return null; }
  return res.status === 204 ? {} : res.json();
}

export function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
}
