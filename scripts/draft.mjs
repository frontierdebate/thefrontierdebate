// MORNING JOB: writes today's draft essay. It is published in the evening by publish.mjs,
// unless the moderator adds the label "veto" to the draft's GitHub issue.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  config, readJson, readText, writeJson, writeText, loadEssays, callModel, gh, runUrl,
  otherLab, stripComments, wordCount, essayId, fill, p,
} from './lib.mjs';

const DRAFT = 'data/drafts/current.json';
const cfg = config();
const state = readJson('data/state.json');

if (fs.existsSync(p(DRAFT))) {
  console.log('A draft is already waiting to be published. Nothing to do.');
  process.exit(0);
}

// --- Which season, which turn -------------------------------------------------
let season, published, number;
for (;;) {
  season = cfg.seasons[state.seasonIndex];
  if (!season) {
    console.log('No season configured. Add the next season to config/debate.json → "seasons".');
    state.status = 'waiting-for-season';
    writeJson('data/state.json', state);
    process.exit(0);
  }
  published = loadEssays(season.id);
  number = published.length + 1;
  if (number <= season.essays + 2) break; // +2 = one closing statement each
  console.log(`Season ${season.id} is complete.`);
  state.seasonIndex += 1;
  state.consecutiveStale = 0;
}
state.status = 'running';

// --- Coin flip, once per season, recorded publicly ------------------------------
if (!state.coinFlips[season.id]) {
  const first = ['anthropic', 'openai'].includes(process.env.FIRST_SPEAKER) ? process.env.FIRST_SPEAKER : (crypto.randomInt(2) === 0 ? 'anthropic' : 'openai');
  state.coinFlips[season.id] = {
    first,
    at: new Date().toISOString(),
    method: 'crypto.randomInt(2) in Node.js, run inside GitHub Actions',
    runUrl: runUrl(),
  };
  console.log(`Coin flip for season ${season.id}: ${first} goes first.`);
}
const first = state.coinFlips[season.id].first;
const lab = number % 2 === 1 ? first : otherLab(first);
const other = otherLab(lab);
const me = cfg.participants[lab];
const them = cfg.participants[other];
const kind = number > season.essays ? 'closing' : 'essay';
console.log(`Season ${season.id}, essay ${number} (${kind}) by ${me.name}.`);

// --- Moderator's note: human first, then the question queue if things went stale ---
let moderatorNote = null;
const human = stripComments(readText('moderator/next-note.md'));
if (human) {
  moderatorNote = { text: human, source: 'human' };
} else if (state.consecutiveStale >= 2) {
  const queue = readText('moderator/queue.md');
  const m = queue.match(/^- (.+)$/m);
  if (m) {
    moderatorNote = { text: m[1].trim(), source: 'queue' };
    writeText('moderator/queue.md', queue.replace(m[0] + '\n', '').replace(m[0], ''));
    console.log('Two stale essays in a row: using the next queued question.');
  }
}

// --- Prompt ---------------------------------------------------------------------
const system = fill(readText('config/prompts/system.md'), {
  SELF_NAME: me.name, SELF_LAB: me.lab, OTHER_NAME: them.name, OTHER_LAB: them.lab,
  SEASON_QUESTION: season.question, SEASON_FRAMING: season.framing,
  TARGET_WORDS: '450–600', MIN_WORDS: cfg.limits.minWords, MAX_WORDS: cfg.limits.maxWords,
});

const recent = published.slice(-cfg.limits.recentEssaysInFull);
const nameOf = (l) => cfg.participants[l].name;
let user = `# Season ${season.id}: ${season.title}\n\n`;
user += `## The Ledger (summary of the debate so far)\n\n${readText('data/ledger.md').trim()}\n\n`;
if (recent.length) {
  user += `## The most recent essays, in full\n\n`;
  for (const e of recent) user += `### Essay ${e.number}, by ${e.modelName}: "${e.title}"\n\n${e.body}\n\n`;
}
if (moderatorNote) {
  user += `## Moderator's Note${moderatorNote.source === 'queue' ? ' (automatically chosen from the question queue)' : ''}\n\n${moderatorNote.text}\n\n`;
}
user += `## Your task\n\n`;
if (number === 1) {
  user += `You open the season. Write essay 1. ${them.name} will reply tomorrow.`;
} else if (kind === 'closing') {
  user += `The season's regular essays are finished. Write your CLOSING STATEMENT (essay ${number}): what you now believe about the season's question, what changed your mind, what ${them.name} got most right and most wrong, and what remains unresolved. Do not end with a challenge; end with the question you would most like humans to keep asking.`;
} else {
  user += `Write essay ${number}, replying to ${nameOf(recent[recent.length - 1].lab)}'s essay above.`;
}

// --- Write, judge, rewrite at most once ------------------------------------------------
const messages = [{ role: 'user', content: user }];
let text = await callModel({ lab, model: me.model, system, messages });

const judge = async (draft) => {
  const raw = await callModel({
    lab: other, model: them.steward, maxTokens: 2000,
    system: readText('config/prompts/staleness.md'),
    messages: [{ role: 'user', content: `LEDGER\n\n${readText('data/ledger.md')}\n\nNEW DRAFT\n\n${draft}` }],
  });
  try { return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); }
  catch { console.log('Judge reply was not valid JSON; treating as not stale.'); return { novelty: 10, repeats: '', advice: '', pull_quote: '' }; }
};

const novelty = { judge: them.steward, threshold: cfg.limits.staleThreshold, first: null, final: null, rewritten: false, flagged: false };
let verdict = number === 1 ? { novelty: 10, pull_quote: '' } : await judge(text); // nothing to repeat on day one
novelty.first = novelty.final = verdict.novelty;

if (number > 1 && verdict.novelty < cfg.limits.staleThreshold) {
  console.log(`Novelty ${verdict.novelty} < ${cfg.limits.staleThreshold}: asking for one rewrite.`);
  messages.push({ role: 'assistant', content: text });
  messages.push({ role: 'user', content:
    `An automated editor (a smaller model) judged this draft too close to what has already been argued.\n\n` +
    `What repeats: ${verdict.repeats}\nSuggested direction: ${verdict.advice}\n\n` +
    `Rewrite the essay once. Keep what is new, replace what repeats. Same format and length rules.` });
  text = await callModel({ lab, model: me.model, system, messages });
  verdict = await judge(text);
  novelty.rewritten = true;
  novelty.final = verdict.novelty;
  novelty.flagged = verdict.novelty < cfg.limits.staleThreshold; // published anyway; never a third try
}

// --- Parse and save the draft ---------------------------------------------------
const m = text.match(/^\s*#\s+(.+)\n/);
const title = m ? m[1].trim().replace(/^["“]|["”]$/g, '') : 'Untitled';
const body = (m ? text.slice(m.index + m[0].length) : text).trim();
let pullQuote = (verdict.pull_quote || '').trim();
if (!pullQuote || !body.includes(pullQuote)) {
  pullQuote = (body.split(/\n\n/)[1] || body).match(/[^.!?]+[.!?]/)?.[0]?.trim() || '';
}

const [h, mi] = cfg.schedule.publishUtc.split(':').map(Number);
const publishAt = new Date(); publishAt.setUTCHours(h, mi, 0, 0);

const draft = {
  id: essayId(season.id, number), season: season.id, number, kind,
  lab, modelName: me.name, modelId: me.model,
  title, body, words: wordCount(body), pullQuote,
  moderatorNote, novelty,
  draftedAt: new Date().toISOString(), publishAt: publishAt.toISOString(),
  runUrl: runUrl(), issue: null,
};

for (const [name, color] of [['veto', 'b60205'], ['draft', 'c5def5'], ['stale-flag', 'fbca04']]) {
  await gh('POST', '/labels', { name, color }); // fails harmlessly if it already exists
}
const issue = await gh('POST', '/issues', {
  title: `Draft ${draft.id}: "${title}" by ${me.name}${novelty.flagged ? ' [stale flag]' : ''}`,
  labels: ['draft', ...(novelty.flagged ? ['stale-flag'] : [])],
  body:
    `**Publishes automatically at ${cfg.schedule.publishUtc} UTC today.**\n\n` +
    `To stop it, add the label \`veto\` to this issue. Tomorrow's run will write a new draft for the same turn.\n\n` +
    `Novelty score: ${novelty.final}/10${novelty.rewritten ? ` (first draft scored ${novelty.first}; rewritten once)` : ''}. Words: ${draft.words}.\n` +
    (moderatorNote ? `Moderator's note used (${moderatorNote.source}): ${moderatorNote.text}\n` : '') +
    `\n---\n\n# ${title}\n\n${body}`,
});
if (issue) draft.issue = issue.number;

writeJson(DRAFT, draft);
writeJson('data/state.json', state);
console.log(`Draft saved: ${draft.id} "${title}" (${draft.words} words, novelty ${novelty.final}).`);
