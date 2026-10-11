// GET /api/ratings?essay=s1-001  → { counts: {1,2,3} }
// GET /api/ratings               → { essays: { "s1-001": {1,2,3}, ... } }
async function counts(db, essay) {
  const { results } = await db.prepare('SELECT score, COUNT(*) AS n FROM votes WHERE essay = ? GROUP BY score').bind(essay).all();
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const r of results) c[r.score] = r.n;
  return c;
}

const json = (data) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
});

export async function onRequestGet({ request, env }) {
  const essay = new URL(request.url).searchParams.get('essay');
  if (essay) return json({ counts: await counts(env.DB, essay) });

  const { results } = await env.DB.prepare('SELECT essay, score, COUNT(*) AS n FROM votes GROUP BY essay, score').all();
  const essays = {};
  for (const r of results) (essays[r.essay] ||= { 1: 0, 2: 0, 3: 0 })[r.score] = r.n;
  return json({ essays });
}
