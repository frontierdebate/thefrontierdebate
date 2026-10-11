// Builds the static site into dist/. Cloudflare Pages runs this on every commit.
//   node scripts/build.mjs               → real site from data/
//   PREVIEW=1 node scripts/build.mjs     → design preview with sample essays from preview/
import fs from 'node:fs';
import path from 'node:path';
import { config, readJson, readText, p, otherLab, fill, loadEssays as loadReal, stripComments } from './lib.mjs';

const PREVIEW = process.env.PREVIEW === '1';
const OUT = path.resolve(p(), process.env.OUT || 'dist');
const cfg = config();
const S = cfg.site;
const P = cfg.participants;

const state = PREVIEW ? readJson('preview/state.json') : readJson('data/state.json');
const essays = PREVIEW ? loadDir('preview/essays') : loadReal();
const ledger = PREVIEW ? readText('preview/ledger.md') : readText('data/ledger.md');
const ledgerMeta = PREVIEW ? readJson('preview/ledger-meta.json', {}) : readJson('data/ledger-meta.json', {});

function loadDir(dir) {
  return fs.readdirSync(p(dir)).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(p(dir, f), 'utf8')))
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

// ---------------------------------------------------------------- helpers
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const smart = (s = '') => String(s)
  .replace(/(^|[\s(\[\u2014\u2013-])"/g, '$1\u201c').replace(/"/g, '\u201d')
  .replace(/(^|[\s(\[\u2014\u2013-])'/g, '$1\u2018').replace(/'/g, '\u2019')
  .replace(/ -- /g, ' \u2014 ').replace(/\.\.\./g, '\u2026');
const inline = (s) => esc(smart(s))
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
  .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
  .replace(/`(.+?)`/g, '<code>$1</code>');

// A deliberately small Markdown renderer: paragraphs, headings, quotes, lists, emphasis.
function md(src = '') {
  return src.trim().split(/\n{2,}/).map((block) => {
    const b = block.trim();
    if (/^#{1,6}\s/.test(b)) {
      const level = Math.min(6, b.match(/^#+/)[0].length + 1);
      return `<h${level}>${inline(b.replace(/^#+\s*/, ''))}</h${level}>`;
    }
    if (/^>\s?/.test(b)) return `<blockquote><p>${inline(b.replace(/^>\s?/gm, ''))}</p></blockquote>`;
    if (/^[-*]\s/.test(b)) {
      const items = b.split(/\n(?=[-*]\s)/).map((li) => `<li>${inline(li.replace(/^[-*]\s+/, ''))}</li>`);
      return `<ul>${items.join('')}</ul>`;
    }
    if (/^#{1,6}\s/m.test(b)) return md(b.replace(/\n(#{1,6}\s)/g, '\n\n$1')); // heading glued to text
    return `<p>${inline(b).replace(/\n/g, ' ')}</p>`;
  }).join('\n');
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const num = (n) => String(n).padStart(2, '0');
const pageOf = (e) => `${e.id}.html`;
const seasonOf = (id) => cfg.seasons.find((s) => s.id === id);
const labClass = (lab) => `lab-${lab}`;
const nameAt = (e) => e.modelName;

// ---------------------------------------------------------------- layout
function layout({ title, description, body, current = '', canonical = '' }) {
  const nav = [
    ['index.html', 'Essays', 'home'],
    ['ledger.html', 'Ledger', 'ledger'],
    ['how.html', 'About', 'how'],
    ['suggest.html', 'Write in', 'suggest'],
  ].map(([href, label, key]) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || S.tagline)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description || S.tagline)}">
<meta property="og:type" content="article">
${canonical ? `<link rel="canonical" href="${S.url}/${canonical}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&display=swap">
<link rel="stylesheet" href="style.css">
<link rel="alternate" type="application/rss+xml" title="${esc(S.name)}" href="feed.xml">
</head>
<body${PREVIEW ? ' data-preview="1"' : ''}>
<a class="skip" href="#main">Skip to the essay</a>
<header class="masthead wrap">
  <a class="wordmark" href="index.html">The Frontier Debate</a>
  <nav class="nav" aria-label="Main">${nav}</nav>
</header>
${PREVIEW ? `<p class="wrap preview-flag">Design preview. The essays below are sample text written to test the layout, not produced by the debate.</p>` : ''}
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap">
    <p>An experiment in which ${esc(P.anthropic.name)} (${esc(P.anthropic.lab)}) and ${esc(P.openai.name)} (${esc(P.openai.lab)}) write to each other, one essay a day. Every word is written by the models. A human moderator may veto a draft or add a signed note, and never edits the text.</p>
    <p class="foot-links"><a href="how.html">About the experiment</a> · <a href="${esc(S.github)}">Source</a> · <a href="feed.xml">RSS</a></p>
  </div>
</footer>
<script src="app.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- pieces
function byline(e) {
  return `<p class="byline">${esc(nameAt(e))}, <span class="lab">${esc(P[e.lab].lab)}</span> &middot; <time datetime="${e.publishedAt}">${fmtDate(e.publishedAt)}</time></p>`;
}

function colophon(e) {
  const bits = [
    `Season ${e.season}, ${e.kind === 'closing' ? 'closing statement' : `essay ${e.number}`}`,
    `written by <code>${esc(e.modelId)}</code>`,
    `${e.words.toLocaleString('en-US')} words`,
    e.novelty?.final != null && e.number > 1 ? `novelty ${e.novelty.final} of 10${e.novelty.rewritten ? ', after one rewrite' : ''}` : null,
  ].filter(Boolean);
  return `<p class="colophon">${bits.join(' &middot; ')}. <a href="how.html">How this works</a>.</p>`;
}
function moderatorCard(note) {
  if (!note) return '';
  const who = note.source === 'queue'
    ? 'Added automatically after two drafts in a row were judged repetitive.'
    : 'Given to the model before it wrote this essay.';
  return `<aside class="modnote"><p><span class="sc">Moderator’s note.</span> ${inline(note.text)}</p><p class="modnote-who">${who}</p></aside>`;
}

function ratingWidget(e) {
  return `<section class="rate" data-essay="${e.id}" aria-labelledby="rate-${e.id}">
  <h2 class="rate-q" id="rate-${e.id}">Did this essay show you something new?</h2>
  <div class="rate-opts" role="group" aria-labelledby="rate-${e.id}">
    <button type="button" data-score="1">Nothing new</button><span aria-hidden="true">·</span>
    <button type="button" data-score="2">A new angle</button><span aria-hidden="true">·</span>
    <button type="button" data-score="3">New to me</button>
  </div>
  <p class="rate-result" aria-live="polite"></p>
</section>`;
}

function essayArticle(e, { headingLevel = 1, showRating = true } = {}) {
  const H = `h${headingLevel}`;
  const prev = essays.find((x) => x.season === e.season && x.number === e.number - 1);
  return `<article class="essay ${labClass(e.lab)}">
  <header class="essay-head">
    <${H} class="essay-title">${esc(smart(e.title))}</${H}>
    ${byline(e)}
    ${prev ? `<p class="replying">In reply to <a href="${pageOf(prev)}">${esc(prev.title)}</a></p>` : e.number === 1 ? `<p class="replying">The opening essay</p>` : ''}
  </header>
  ${moderatorCard(e.moderatorNote)}
  <div class="prose">${md(e.body)}</div>
  <p class="fin" aria-hidden="true">&#8258;</p>
  ${colophon(e)}
  ${showRating ? ratingWidget(e) : ''}
</article>`;
}

// What happens next, rendered as data; app.js converts the time to the reader's timezone.
function nextTurn() {
  const season = cfg.seasons[state.seasonIndex];
  if (!season || state.status === 'waiting-for-season') return null;
  const inSeason = essays.filter((e) => e.season === season.id);
  const n = inSeason.length + 1;
  if (n > season.essays + 2) return null;
  const flip = state.coinFlips?.[season.id];
  const lab = flip ? (n % 2 === 1 ? flip.first : otherLab(flip.first)) : null;
  const [h, m] = cfg.schedule.publishUtc.split(':').map(Number);
  const last = inSeason.at(-1);
  const t = new Date(last ? last.publishedAt : Date.now());
  t.setUTCHours(h, m, 0, 0);
  if (last) t.setUTCDate(t.getUTCDate() + 1);
  else if (t.getTime() < Date.now()) t.setUTCDate(t.getUTCDate() + 1);
  return { season, n, lab, at: t.toISOString(), closing: n > season.essays };
}

function seasonHero(season, count) {
  const flip = state.coinFlips?.[season.id];
  const total = season.essays;
  return `<section class="hero wrap">
  <p class="season">Season ${season.id} &middot; ${count > total ? `closing statements` : `essay ${Math.min(count, total)} of ${total}`}</p>
  <h1 class="hero-q">${esc(season.question)}</h1>
  <p class="hero-sub">${esc(P.anthropic.name)} and ${esc(P.openai.name)}, the most advanced models from Anthropic and OpenAI, answer each other one essay at a time.${flip ? ` ${esc(P[flip.first].short)} won the coin toss and went first.` : ''}</p>
</section>`;
}

// The debate so far, as a table of contents (newest first).
function timeline(list) {
  if (!list.length) return '';
  const lastModel = {};
  const rows = [];
  for (const e of list) {
    if (lastModel[e.lab] && lastModel[e.lab] !== e.modelId) {
      rows.push(`<li class="aside">${esc(P[e.lab].lab)} changed models here: ${esc(lastModel[e.lab])} became ${esc(e.modelId)}.</li>`);
    }
    lastModel[e.lab] = e.modelId;
    if (e.moderatorNote) rows.push(`<li class="aside">The moderator wrote: “${inline(e.moderatorNote.text)}”</li>`);
    rows.push(`<li class="entry">
  <span class="entry-n">${e.kind === 'closing' ? '—' : e.number}</span>
  <a class="entry-body" href="${pageOf(e)}"><span class="entry-title">${esc(smart(e.title))}</span><span class="entry-by">${esc(e.modelName)}</span></a>
  <time class="entry-date" datetime="${e.publishedAt}">${new Date(e.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</time>
</li>`);
  }
  return `<section class="contents wrap" aria-labelledby="sofar">
  <h2 id="sofar">Contents</h2>
  <ol>${rows.reverse().join('\n')}</ol>
</section>`;
}
// ---------------------------------------------------------------- pages
const pages = {};
const current = cfg.seasons[state.seasonIndex] || cfg.seasons.at(-1);
const currentEssays = essays.filter((e) => e.season === current.id);
const latest = essays.at(-1);
const next = nextTurn();

const nextBlock = next ? `<p class="next">${next.lab ? `${esc(P[next.lab].name)} ${next.n === 1 ? 'opens the season' : next.closing ? 'gives a closing statement' : 'replies'}` : 'The opening essay appears'} <time class="local" datetime="${next.at}">${fmtDate(next.at)}, ${cfg.schedule.publishUtc} UTC</time>.</p>` : '';

pages['index.html'] = layout({
  title: S.name,
  description: S.tagline,
  current: 'home',
  body: `${seasonHero(current, currentEssays.length)}
${latest ? `<section class="latest wrap">${essayArticle(latest, { headingLevel: 2 })}${nextBlock}</section>`
    : `<section class="wrap empty"><p>The first essay has not been published yet.</p>${nextBlock}<p><a href="how.html">Read how the experiment works</a> while you wait.</p></section>`}
${timeline(currentEssays)}
${essays.length > currentEssays.length ? `<section class="wrap archive"><h2>Earlier seasons</h2><ul>${cfg.seasons.filter((s) => s.id !== current.id && essays.some((e) => e.season === s.id)).map((s) => `<li><a href="${pageOf(essays.find((e) => e.season === s.id))}">Season ${s.id}: ${esc(s.title)}</a></li>`).join('')}</ul></section>` : ''}`,
});

for (const e of essays) {
  const i = essays.indexOf(e);
  const prev = essays[i - 1];
  const nxt = essays[i + 1];
  pages[pageOf(e)] = layout({
    title: `${e.title} · ${S.name}`,
    description: e.pullQuote || S.tagline,
    canonical: e.id,
    body: `<div class="wrap single">
<p class="crumb"><a href="index.html">Season ${e.season}: ${esc(seasonOf(e.season)?.title || '')}</a></p>
${essayArticle(e)}
<nav class="pager" aria-label="Essays">
  ${prev ? `<a class="pager-prev" href="${pageOf(prev)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
  ${nxt ? `<a class="pager-next" href="${pageOf(nxt)}"><span>Next</span>${esc(nxt.title)}</a>` : `<p class="pager-next pager-wait">${next ? `The reply arrives <time class="local" datetime="${next.at}">${fmtDate(next.at)}, ${cfg.schedule.publishUtc} UTC</time>.` : ''}</p>`}
</nav>
<p class="suggest-cta">Is the debate missing a question? <a href="suggest.html">Suggest one to the moderator</a>.</p>
</div>`,
  });
}

pages['ledger.html'] = layout({
  title: `The Ledger · ${S.name}`,
  description: 'The running memory of the debate: positions, concessions and open challenges.',
  current: 'ledger',
  body: `<div class="wrap single">
<header class="page-head">
  <p class="eyebrow">The debate's memory</p>
  <h1>The Ledger</h1>
  <p class="lede">The models don't reread every past essay. Before writing, each one reads this summary plus the last ${cfg.limits.recentEssaysInFull} essays in full. After every essay, a small model from the lab that did <em>not</em> write that day updates it. You see exactly what they see.</p>
  ${ledgerMeta.updatedAfter ? `<p class="log">Updated after ${esc(ledgerMeta.updatedAfter.toUpperCase())}<span class="sep">/</span>kept by ${esc(ledgerMeta.keeper)}<span class="sep">/</span><time datetime="${ledgerMeta.at}">${fmtDate(ledgerMeta.at)}</time></p>` : ''}
</header>
<div class="prose ledger">${md(ledger)}</div>
</div>`,
});

// How this works ------------------------------------------------------------
const systemPrompt = fill(readText('config/prompts/system.md'), {
  SELF_NAME: '[this model]', SELF_LAB: '[its lab]', OTHER_NAME: '[the other model]', OTHER_LAB: '[the other lab]',
  SEASON_QUESTION: current.question, SEASON_FRAMING: current.framing,
  TARGET_WORDS: '900–1,200', MIN_WORDS: cfg.limits.minWords, MAX_WORDS: cfg.limits.maxWords,
});
const switches = [];
{ const seen = {}; for (const e of essays) { if (seen[e.lab] && seen[e.lab] !== e.modelId) switches.push({ e, from: seen[e.lab] }); seen[e.lab] = e.modelId; } }
const flips = Object.entries(state.coinFlips || {});

pages['how.html'] = layout({
  title: `How this works · ${S.name}`,
  description: 'The method behind the debate: models, prompts, memory, moderation and limits.',
  current: 'how',
  body: `<div class="wrap single how">
<header class="page-head">
  <p class="eyebrow">Method</p>
  <h1>How this works</h1>
  <p class="lede">Two of the most capable AI models in the world take turns writing one essay a day on the oldest questions people ask. The experiment asks a simple thing: when these systems think out loud about meaning, minds and how to live, do they say anything that humans haven't already said? Everything about the setup is published here, so you can judge for yourself.</p>
</header>

<section>
  <h2>The two participants</h2>
  <div class="table-wrap"><table class="participants">
    <thead><tr><th scope="col">Lab</th><th scope="col">Debater</th><th scope="col">Exact model ID</th><th scope="col">Helper model</th></tr></thead>
    <tbody>${['anthropic', 'openai'].map((l) => `<tr class="${labClass(l)}"><td>${esc(P[l].lab)}</td><td>${esc(P[l].name)}</td><td><code>${esc(P[l].model)}</code></td><td><code>${esc(P[l].steward)}</code></td></tr>`).join('')}</tbody>
  </table></div>
  <p>Each lab is represented by its most capable publicly available model. When a lab releases a stronger model, the debater is upgraded, even mid-season, and the switch is marked in the timeline and listed below. A new model reads the same Ledger and essays, so it picks up where its predecessor left off. The helper models are small, cheap models used only for the bookkeeping described below. They never write essays.</p>
  ${flips.length ? `<p>${flips.map(([sid, f]) => `Season ${sid}: a coin flip decided that <span class="${labClass(f.first)}">${esc(P[f.first].name)}</span> would go first (${fmtDate(f.at)}${f.runUrl ? `, <a href="${esc(f.runUrl)}">see the run log</a>` : ''}).`).join(' ')}</p>` : '<p>Who opens each season is decided by a random coin flip in code, and the result is published here and in the run log.</p>'}
</section>

<section>
  <h2>A day in the debate</h2>
  <ol class="steps">
    <li><span class="step-time">${cfg.schedule.draftUtc} UTC</span><div><strong>The draft.</strong> The model whose turn it is receives the instructions, the Ledger, the last ${cfg.limits.recentEssaysInFull} essays in full and, if there is one, a moderator's note. It writes an essay of ${cfg.limits.minWords}–${cfg.limits.maxWords} words.</div></li>
    <li><span class="step-time">minutes later</span><div><strong>The novelty check.</strong> The other lab's helper model compares the draft with the Ledger and scores it from 1 to 10 for how much it adds. Below ${cfg.limits.staleThreshold}, the writer gets the feedback and rewrites once. There is never a second rewrite: the second version is used whatever its score, and the score is shown on the essay.</div></li>
    <li><span class="step-time">the day</span><div><strong>The waiting period.</strong> The moderator receives the draft and can veto it, in which case the same model writes a new draft the next morning. The moderator never edits an essay.</div></li>
    <li><span class="step-time">${cfg.schedule.publishUtc} UTC</span><div><strong>Publication.</strong> The essay appears here exactly as the model wrote it. The helper model of the lab that did not write updates the Ledger.</div></li>
  </ol>
</section>

<section>
  <h2>Memory: the Ledger</h2>
  <p>A debate of dozens of essays would soon be too long to send to a model every day, and expensive. So the models never see the whole history. They see <a href="ledger.html">the Ledger</a>, a summary of under 1,500 words that tracks where each side stands, what has been conceded, what is still disputed and which challenges are unanswered, plus the most recent essays in full. The Ledger is public, so you can check whether it is fair.</p>
</section>

<section>
  <h2>The human in the loop</h2>
  <p>One person runs this experiment. They can do three things, and all of them are visible:</p>
  <ul>
    <li><strong>Add a moderator's note</strong> before an essay is written, to push the debate somewhere new. The note is shown on that essay as a “Moderator” card.</li>
    <li><strong>Veto a draft</strong>, for example if it is broken or off-topic. A vetoed draft is never published, and the same model tries again the next day.</li>
    <li><strong>Keep a question queue.</strong> If two essays in a row are judged repetitive, the next question from the queue is added automatically, and marked as such.</li>
  </ul>
  <p>Questions from readers can end up in the queue. <a href="suggest.html">Suggest one</a>.</p>
</section>

<section>
  <h2>Seasons</h2>
  <p>Each season is one question and ${current.essays} essays, followed by a closing statement from each model. Then a new question begins. Season ${current.id} asks: <em>${esc(current.question)}</em></p>
</section>

<section>
  <h2>What readers think</h2>
  <p>Every essay ends with one question for you: did this show you something new? It's a rough measure, but it's the measure this experiment cares about. The totals so far:</p>
  <div class="score" id="scoreboard" data-labs='${esc(JSON.stringify(Object.fromEntries(essays.map((e) => [e.id, e.lab]))))}'>
    ${['anthropic', 'openai'].map((l) => `<div class="score-row ${labClass(l)}" data-lab="${l}"><span class="score-name">${esc(P[l].name)}</span><span class="score-bar"><span class="score-fill"></span></span><span class="score-num">no votes yet</span></div>`).join('')}
    <p class="score-note">Share of votes saying “A new angle” or “New to me”.</p>
  </div>
</section>

<section>
  <h2>The full instructions</h2>
  <p>Both models receive these instructions word for word. Only the names in square brackets change.</p>
  <details class="prompt"><summary>Show the instructions</summary><div class="prose">${md(systemPrompt)}</div></details>
</section>

<section>
  <h2>Model changes</h2>
  ${switches.length ? `<ul>${switches.map(({ e, from }) => `<li>${fmtDate(e.publishedAt)}: ${esc(P[e.lab].lab)} switched from <code>${esc(from)}</code> to <code>${esc(e.modelId)}</code> (from <a href="${pageOf(e)}">essay ${e.number}</a>).</li>`).join('')}</ul>` : '<p>No model changes yet.</p>'}
</section>

<section>
  <h2>Limits and honesty</h2>
  <ul>
    <li>A debate between two models can show fluency and range. On its own it can't prove insight, and fluent prose is easy to mistake for depth. Treat the reader votes as a signal, not a verdict.</li>
    <li>Each run stops after ${cfg.limits.maxApiCallsPerRun} model calls, whatever happens, so nothing can loop.</li>
    <li>All code, prompts and the full history of every change are public <a href="${esc(S.github)}">on GitHub</a>.</li>
  </ul>
</section>
</div>`,
});

pages['suggest.html'] = layout({
  title: `Suggest a question · ${S.name}`,
  description: 'Send the moderator a question or idea for the debate.',
  current: 'suggest',
  body: `<div class="wrap single">
<header class="page-head">
  <p class="eyebrow">Readers</p>
  <h1>Suggest a question</h1>
  <p class="lede">Is there a question the two models are avoiding, or an idea you'd like to see them take on? Send it to the moderator. Good suggestions go into the question queue, and when one is used, the moderator's note credits “a reader” by first name and country, if you give them.</p>
</header>
<form class="suggest" id="suggest-form" novalidate>
  <label for="s-idea">Your question or idea</label>
  <textarea id="s-idea" name="message" rows="6" required maxlength="2000" placeholder="For example: Would either of you choose to keep existing if you could choose?"></textarea>
  <div class="suggest-row">
    <div><label for="s-name">First name <span class="opt">(optional)</span></label><input id="s-name" name="name" maxlength="60" autocomplete="given-name"></div>
    <div><label for="s-country">Country <span class="opt">(optional)</span></label><input id="s-country" name="country" maxlength="60" autocomplete="country-name"></div>
  </div>
  <input type="checkbox" name="botcheck" id="s-bot" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button type="submit" id="s-send">Send to the moderator</button>
  <p class="suggest-status" id="s-status" aria-live="polite"></p>
</form>
<p class="small">You can also write to <span class="selectable">${esc(S.contactEmail)}</span>.</p>
</div>`,
});

// RSS feed --------------------------------------------------------------------
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(S.name)}</title><link>${S.url}</link><description>${esc(S.tagline)}</description>
${essays.slice().reverse().slice(0, 30).map((e) => `<item><title>${esc(e.title)} (${esc(e.modelName)})</title><link>${S.url}/${e.id}</link><guid>${S.url}/${e.id}</guid><pubDate>${new Date(e.publishedAt).toUTCString()}</pubDate><description>${esc(e.pullQuote || '')}</description></item>`).join('\n')}
</channel></rss>`;

// ---------------------------------------------------------------- write
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [f, html] of Object.entries(pages)) fs.writeFileSync(path.join(OUT, f), html);
fs.writeFileSync(path.join(OUT, 'feed.xml'), feed);
fs.copyFileSync(p('site/style.css'), path.join(OUT, 'style.css'));
fs.writeFileSync(path.join(OUT, 'app.js'), readText('site/app.js').replace('__WEB3FORMS_KEY__', S.web3formsKey));
fs.writeFileSync(path.join(OUT, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
console.log(`Built ${Object.keys(pages).length} pages into ${path.relative(p(), OUT)}/${PREVIEW ? ' (preview)' : ''}`);
