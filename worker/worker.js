/**
 * Optional shared endpoint for CalDrop.
 *
 * The app works fine without this: users bring their own key. Deploy this only
 * if you want people to be able to try CalDrop without one. It holds a single
 * key server-side and exposes just the chat-completions call the app makes.
 *
 *   npx wrangler deploy
 *   npx wrangler secret put OPENAI_API_KEY
 *
 * Then build the site with VITE_PROXY_URL=https://<your-worker>.workers.dev/v1
 */

const DAILY_LIMIT = 20; // requests per IP per day
const MAX_BODY_BYTES = 12 * 1024 * 1024; // a couple of downscaled poster images
const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o'];

function cors(origin, allowed) {
  const ok = !allowed || allowed === '*' || allowed.split(',').includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : 'null',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/**
 * Best-effort per-IP quota. With the RATE_LIMIT KV namespace bound it is a real
 * daily limit; without it, it only bounds a single isolate, which still blunts
 * the obvious abuse but is not a guarantee.
 */
const memory = new Map();

async function overQuota(env, ip) {
  const key = `${ip}:${new Date().toISOString().slice(0, 10)}`;
  if (env.RATE_LIMIT) {
    const used = Number((await env.RATE_LIMIT.get(key)) || '0');
    if (used >= DAILY_LIMIT) return true;
    await env.RATE_LIMIT.put(key, String(used + 1), { expirationTtl: 172800 });
    return false;
  }
  const used = memory.get(key) || 0;
  if (used >= DAILY_LIMIT) return true;
  memory.set(key, used + 1);
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json(405, { error: 'POST only' }, headers);

    const url = new URL(request.url);
    if (!url.pathname.endsWith('/chat/completions')) {
      return json(404, { error: 'Not found' }, headers);
    }

    const length = Number(request.headers.get('Content-Length') || '0');
    if (length > MAX_BODY_BYTES) return json(413, { error: 'Payload too large' }, headers);

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'Invalid JSON' }, headers);
    }

    if (!ALLOWED_MODELS.includes(body.model)) {
      return json(400, { error: `model must be one of ${ALLOWED_MODELS.join(', ')}` }, headers);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await overQuota(env, ip)) {
      return json(
        429,
        { error: 'Daily limit for the shared endpoint reached. Add your own API key in Settings.' },
        headers,
      );
    }

    const upstream = await fetch(`${env.UPSTREAM_URL || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    // Streamed straight through, so the app's live preview still works.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...headers,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};
