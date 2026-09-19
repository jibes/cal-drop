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

const DEFAULTS = {
  DAILY_LIMIT: 20, // requests per IP per day
  MAX_BODY_BYTES: 12 * 1024 * 1024, // a couple of downscaled poster images
  ALLOWED_MODELS: 'gpt-4o-mini,gpt-4o',
};

const settings = (env) => ({
  dailyLimit: Number(env.DAILY_LIMIT || DEFAULTS.DAILY_LIMIT),
  maxBodyBytes: Number(env.MAX_BODY_BYTES || DEFAULTS.MAX_BODY_BYTES),
  allowedModels: String(env.ALLOWED_MODELS || DEFAULTS.ALLOWED_MODELS)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
});

const originList = (allowed) =>
  String(allowed || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

function originAllowed(origin, allowed) {
  if (!allowed || allowed === '*') return true;
  return originList(allowed).includes(origin);
}

/** Compare without leaking the answer through how long it took. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(origin, allowed) {
  const ok = originAllowed(origin, allowed) && origin !== '';
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

async function overQuota(env, ip, limit) {
  const key = `${ip}:${new Date().toISOString().slice(0, 10)}`;
  if (env.RATE_LIMIT) {
    const used = Number((await env.RATE_LIMIT.get(key)) || '0');
    if (used >= limit) return true;
    await env.RATE_LIMIT.put(key, String(used + 1), { expirationTtl: 172800 });
    return false;
  }
  const used = memory.get(key) || 0;
  if (used >= limit) return true;
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

    // A browser that is not one of ours is turned away outright. A request with
    // no Origin at all is not a browser, so it is left to the access code below.
    if (origin && !originAllowed(origin, env.ALLOWED_ORIGINS)) {
      return json(403, { error: 'This endpoint does not serve that origin.' }, headers);
    }

    /**
     * Optional shared secret. The site is public, so anything baked into its
     * bundle is public too — this has to be something the user types once and
     * that lives only on their device, or it protects nothing.
     */
    if (env.ACCESS_CODE) {
      const presented = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!sameSecret(presented, env.ACCESS_CODE)) {
        return json(
          401,
          { error: 'This shared endpoint needs an access code. Enter it as the API key in Settings.' },
          headers,
        );
      }
    }

    const config = settings(env);

    if (!env.OPENAI_API_KEY) {
      // Without this the upstream just answers 401 and the app reports a key
      // problem the user cannot fix, because the key is not theirs.
      return json(
        500,
        { error: 'This endpoint is missing its upstream key. Its operator must set the OPENAI_API_KEY secret.' },
        headers,
      );
    }

    // Content-Length is absent on a chunked upload, so it can only be a fast
    // reject — the real cap has to be measured on the body actually received.
    const declared = Number(request.headers.get('Content-Length') || '0');
    if (declared > config.maxBodyBytes) return json(413, { error: 'Payload too large' }, headers);

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > config.maxBodyBytes) {
      return json(413, { error: 'Payload too large' }, headers);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid JSON' }, headers);
    }

    if (!config.allowedModels.includes(body.model)) {
      return json(400, { error: `model must be one of ${config.allowedModels.join(', ')}` }, headers);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await overQuota(env, ip, config.dailyLimit)) {
      const untilMidnightUtc = Math.ceil(
        (Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) -
          Date.now()) /
          1000,
      );
      return json(
        429,
        { error: 'Daily limit for the shared endpoint reached. Add your own API key in Settings.' },
        { ...headers, 'Retry-After': String(untilMidnightUtc) },
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
