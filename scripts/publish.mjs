// EVENING JOB: publishes the morning's draft unless the moderator vetoed it,
// then updates the Ledger and the debate state.
import fs from 'node:fs';
import {
  config, readJson, readText, writeJson, writeText, callModel, gh, otherLab, fill, p,
} from './lib.mjs';

const DRAFT = 'data/drafts/current.json';
const cfg = config();
const state = readJson('data/state.json');

if (!fs.existsSync(p(DRAFT))) {
  console.log('No draft waiting. Nothing to publish.');
  process.exit(0);
}
const draft = readJson(DRAFT);

// --- Veto? -------------------------------------------------------------------------
if (draft.issue) {
  const issue = await gh('GET', `/issues/${draft.issue}`);
  if (issue && issue.labels.some((l) => l.name === 'veto')) {
    console.log(`Draft ${draft.id} was vetoed. Discarding it; the same turn is redrafted tomorrow.`);
    fs.unlinkSync(p(DRAFT));
    if (draft.moderatorNote?.source === 'queue') {
      // put the queued question back at the top of the queue
      const q = readText('moderator/queue.md');
      const at = q.indexOf('\n- ');
      writeText('moderator/queue.md', at >= 0 ? q.slice(0, at) + `\n- ${draft.moderatorNote.text}` + q.slice(at) : q + `\n- ${draft.moderatorNote.text}\n`);
    }
    await gh('POST', `/issues/${draft.issue}/comments`, { body: 'Vetoed: not published. A new draft for this turn will be written tomorrow morning.' });
    await gh('PATCH', `/issues/${draft.issue}`, { state: 'closed', state_reason: 'not_planned' });
    process.exit(0);
  }
}

// --- Publish ---------------------------------------------------------------------
const essay = { ...draft, publishedAt: new Date().toISOString() };
delete essay.publishAt;
writeJson(`data/essays/${essay.id}.json`, essay);
fs.unlinkSync(p(DRAFT));

if (draft.moderatorNote?.source === 'human') {
  // empty the note file, keeping the instructions comment
  const note = readText('moderator/next-note.md');
  const comment = (note.match(/<!--[\s\S]*?-->/) || [''])[0];
  writeText('moderator/next-note.md', comment + '\n');
}
state.consecutiveStale = draft.novelty.flagged ? state.consecutiveStale + 1 : 0;
writeJson('data/state.json', state);
console.log(`Published ${essay.id}: "${essay.title}".`);

// --- Update the Ledger (kept by the small model of the lab that did NOT write today) ---
try {
  const keeper = otherLab(draft.lab);
  const ledger = await callModel({
    lab: keeper,
    model: cfg.participants[keeper].steward,
    maxTokens: 4000,
    system: fill(readText('config/prompts/ledger.md'), {
      A_NAME: cfg.participants.anthropic.name, B_NAME: cfg.participants.openai.name,
    }),
    messages: [{ role: 'user', content:
      `CURRENT LEDGER\n\n${readText('data/ledger.md')}\n\n` +
      `NEWEST ESSAY: essay ${essay.number} (season ${essay.season}), by ${essay.modelName}: "${essay.title}"\n\n${essay.body}` }],
  });
  if (ledger.length > 200) {
    writeText('data/ledger.md', ledger.trim() + '\n');
    writeJson('data/ledger-meta.json', { updatedAfter: essay.id, keeper: cfg.participants[keeper].steward, at: new Date().toISOString() });
  }
} catch (err) {
  // Never block publication on the Ledger: the old Ledger stays, the essays are still read in full.
  console.log(`Ledger update failed, keeping the previous Ledger: ${err.message}`);
}

if (draft.issue) {
  await gh('POST', `/issues/${draft.issue}/comments`, { body: `Published at ${cfg.site.url}/${essay.id}` });
  await gh('PATCH', `/issues/${draft.issue}`, { state: 'closed', state_reason: 'completed' });
}
