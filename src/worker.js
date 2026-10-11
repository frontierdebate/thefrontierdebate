// The Frontier Debate: Cloudflare Worker.
// Static pages in dist/ are served automatically; this code only handles the ratings API.
//   POST /api/rate      { essay: "s1-001", score: 1|2|3 }  → one vote per reader per essay
//   GET  /api/ratings?essay=s1-001                      → { counts: {1,2,3} }
//   GET  /api/ratings                                   → { essays: { id: {1,2,3} } }
// Readers are identified only by a salted hash of their IP, never by the IP itself.

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });

async function counts(db, essay) {
  const { results } = await db.prepare('SELECT score, COUNT(*) AS n FROM votes WHERE essay = ? GROUP BY score').bind(essay).all();
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const r of results) c[r.score] = r.n;
  return c;
}

async function rate(request, env) {
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

async function ratings(request, env) {
  const cache = { 'cache-control': 'public, max-age=60' };
  const essay = new URL(request.url).searchParams.get('essay');
  if (essay) return json({ counts: await counts(env.DB, essay) }, 200, cache);
  const { results } = await env.DB.prepare('SELECT essay, score, COUNT(*) AS n FROM votes GROUP BY essay, score').all();
  const essays = {};
  for (const r of results) (essays[r.essay] ||= { 1: 0, 2: 0, 3: 0 })[r.score] = r.n;
  return json({ essays }, 200, cache);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/rate' && request.method === 'POST') return await rate(request, env);
      if (pathname === '/api/ratings' && request.method === 'GET') return await ratings(request, env);
    } catch (err) {
      return json({ error: 'Server error' }, 500);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
