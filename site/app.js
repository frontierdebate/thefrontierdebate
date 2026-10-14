// The Frontier Debate: small enhancements. The site reads fine without this script.
(() => {
  const PREVIEW = !!document.querySelector('[data-preview="1"]');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // Show "next essay" times in the reader's own timezone.
  for (const t of document.querySelectorAll('time.local')) {
    const d = new Date(t.dateTime);
    if (isNaN(d)) continue;
    t.textContent = d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' your time';
  }

  // Left and right arrow keys move between essays.
  document.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    const sel = ev.key === 'ArrowLeft' ? '.essay-arrows a[aria-label="Previous essay"]' : ev.key === 'ArrowRight' ? '.essay-arrows a[aria-label="Next essay"]' : null;
    const link = sel && document.querySelector(sel);
    if (link) location.href = link.href;
  });

  // ---- ratings ---------------------------------------------------------------
  const LABELS = { 1: 'Nothing new', 2: 'A new angle', 3: 'New to me' };
  const describe = (c) => {
    const total = (c[1] || 0) + (c[2] || 0) + (c[3] || 0);
    if (!total) return '';
    const pct = (n) => Math.round(((n || 0) / total) * 100);
    return `${total} ${total === 1 ? 'vote' : 'votes'}: ${pct(3)}% new to me, ${pct(2)}% a new angle, ${pct(1)}% nothing new.`;
  };

  for (const box of document.querySelectorAll('.rate')) {
    const id = box.dataset.essay;
    const out = box.querySelector('.rate-result');
    const buttons = [...box.querySelectorAll('button')];
    const mark = (score) => buttons.forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.score === String(score))); b.disabled = true; });

    const prior = store.get(`vote:${id}`);
    if (prior) mark(prior);

    if (PREVIEW) { out.textContent = 'Voting opens when the site is live.'; continue; }

    fetch(`/api/ratings?essay=${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d && prior) out.textContent = describe(d.counts);
    }).catch(() => {});

    for (const b of buttons) {
      b.addEventListener('click', async () => {
        const score = b.dataset.score;
        mark(score);
        out.textContent = 'Saving your vote…';
        try {
          const r = await fetch('/api/rate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ essay: id, score: Number(score) }) });
          const d = await r.json();
          if (!r.ok && r.status !== 409) throw new Error(d.error || 'failed');
          store.set(`vote:${id}`, score);
          out.textContent = `You voted “${LABELS[score]}”. ${describe(d.counts)}`;
        } catch {
          buttons.forEach((x) => { x.disabled = false; x.removeAttribute('aria-pressed'); });
          out.textContent = 'Your vote could not be saved. Check your connection and try again.';
        }
      });
    }
  }

  // ---- scoreboard on "How this works" -----------------------------------------
  const board = document.getElementById('scoreboard');
  if (board && !PREVIEW) {
    const labOf = JSON.parse(board.dataset.labs || '{}');
    fetch('/api/ratings').then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d) return;
      const sum = { anthropic: [0, 0], openai: [0, 0] }; // [positive, total]
      for (const [essay, c] of Object.entries(d.essays || {})) {
        const lab = labOf[essay];
        if (!sum[lab]) continue;
        sum[lab][0] += (c[2] || 0) + (c[3] || 0);
        sum[lab][1] += (c[1] || 0) + (c[2] || 0) + (c[3] || 0);
      }
      for (const row of board.querySelectorAll('.score-row')) {
        const [pos, tot] = sum[row.dataset.lab];
        if (!tot) continue;
        const pct = Math.round((pos / tot) * 100);
        row.querySelector('.score-fill').style.width = pct + '%';
        row.querySelector('.score-num').textContent = `${pct}% of ${tot} votes`;
      }
    }).catch(() => {});
  } else if (board && PREVIEW) {
    const demo = { anthropic: [62, 140], openai: [58, 133] };
    for (const row of board.querySelectorAll('.score-row')) {
      const [pos, tot] = demo[row.dataset.lab];
      row.querySelector('.score-fill').style.width = Math.round((pos / tot) * 100) + '%';
      row.querySelector('.score-num').textContent = `${Math.round((pos / tot) * 100)}% of ${tot} votes (sample)`;
    }
  }

  // ---- suggestion form (delivered by Web3Forms to the moderator's inbox) ---------
  const form = document.getElementById('suggest-form');
  if (form) {
    const status = document.getElementById('s-status');
    const send = document.getElementById('s-send');
    const draftKey = 'suggest-draft';
    const idea = document.getElementById('s-idea');
    idea.value = store.get(draftKey) || '';
    idea.addEventListener('input', () => store.set(draftKey, idea.value));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!idea.value.trim()) { status.textContent = 'Write your question first.'; idea.focus(); return; }
      if (PREVIEW) { status.textContent = 'Sending works once the site is live.'; return; }
      send.disabled = true;
      status.textContent = 'Sending…';
      const data = Object.fromEntries(new FormData(form));
      try {
        const r = await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            access_key: '__WEB3FORMS_KEY__',
            subject: 'New question for The Frontier Debate',
            from_name: 'The Frontier Debate',
            ...data,
          }),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.message);
        form.reset();
        store.set(draftKey, '');
        status.textContent = 'Sent. Thank you: the moderator reads every suggestion.';
      } catch {
        status.textContent = 'Your suggestion could not be sent. Try again in a minute.';
      } finally {
        send.disabled = false;
      }
    });
  }
})();
