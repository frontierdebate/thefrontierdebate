// POST /api/rate  { essay: "s1-001", score: 1|2|3 }
// One vote per reader per essay. Readers are identified only by a salted hash of their IP,
// never by the IP itself.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function counts(db, essay) {
  const { results } = await db.prepare('SELECT score, COUNT(*) AS n FROM votes WHERE essay = ? GROUP BY score').bind(essay).all();
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const r of results) c[r.score] = r.n;
  return c;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const essay = String(body.essay || '');
  const score = Number(body.score);
  if (!/^s\d+-\d{3}$/.test(essay) || ![1, 2, 3].includes(score)) return json({ error: 'Invalid vote' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.VOTE_SALT || 'tfd'}:${essay}:${ip}`));
  const voter = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const res = await env.DB.prepare('INSERT OR IGNORE INTO votes (essay, voter, score, at) VALUES (?, ?, ?, ?)')
    .bind(essay, voter, score, new Date().toISOString()).run();
  const already = res.meta.changes === 0;
  return json({ ok: !already, already, counts: await counts(env.DB, essay) }, already ? 409 : 200);
}
