/**
 * CalDrop fetcher — it reads a web page and hands back its text. That is all.
 *
 * A browser may not fetch another site, and no amount of the app being clever
 * changes that: something on a server has to do it. The endpoint does it on
 * the way to asking a model about the page; this does the same thing on its
 * own, so an app calling its own API — which has no such route — can read a
 * link in two steps instead of not at all. Fetch here, then send the text
 * wherever the settings point.
 *
 * What it will not be is an open door. A server that makes requests on a
 * stranger's say-so is a useful thing to find: it fetches what it can reach
 * and hands back what it read, which is how an address on somebody's private
 * network ends up in a reply. The protections against that live in
 * ../shared/page.js and are the same ones the endpoint uses — every hop of a
 * redirect checked, not only the address that was typed.
 *
 * And an allowlist of origins is not one of those protections. It decides
 * which *pages* a browser will let call this; it decides nothing at all about
 * anyone calling it directly, who can claim any origin they like. So the
 * access code is what actually gates this, and running without one is a
 * choice that has to be made out loud.
 */
import { fetchPage } from '../shared/page.js';

const DEFAULTS = {
  MAX_PAGE_BYTES: 1024 * 1024,
  ALLOWED_ORIGINS: 'https://jibes.github.io,https://localhost,capacitor://localhost',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULTS.ALLOWED_ORIGINS)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const headers = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!headers['Access-Control-Allow-Origin']) {
      return json(403, { error: 'This fetcher does not serve that origin.' }, headers);
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.replace(/\/+$/, '').endsWith('/fetch')) {
      return json(404, { error: 'POST a JSON body of {"url": "https://…"} to /fetch.' }, headers);
    }

    if (env.ACCESS_CODE) {
      const presented = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!(await sameSecret(presented, env.ACCESS_CODE))) {
        return json(401, { error: 'Wrong or missing access code. Enter it in Settings.' }, headers);
      }
    } else if (env.ALLOW_NO_CODE !== 'yes') {
      // Fails closed, for the same reason the endpoint does: an open one
      // works beautifully right up until the wrong person finds the URL.
      return json(
        503,
        {
          error:
            'This fetcher has no access code set, so it is not serving anyone. Its operator sets ' +
            'one as the repository secret FETCHER_ACCESS_CODE, which the deploy workflow uploads ' +
            'as this worker\'s ACCESS_CODE — or ALLOW_NO_CODE="yes" to run it open on purpose.',
        },
        headers,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'Send a JSON body of {"url": "https://…"}.' }, headers);
    }

    const max = Number(env.MAX_PAGE_BYTES || DEFAULTS.MAX_PAGE_BYTES);
    const result = await fetchPage(String(body.url || ''), max);
    if (result.error) return json(400, { error: result.error }, headers);
    if (!result.text.trim()) {
      return json(422, { error: 'That page had no readable text. Try a screenshot instead.' }, headers);
    }
    return json(200, { text: result.text }, headers);
  },
};

function cors(origin, allowed) {
  const ok = allowed.includes('*') ? Boolean(origin) : allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : '',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Compared in constant time, and hashed first so the comparison is always
 *  the same length whatever was presented. */
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
