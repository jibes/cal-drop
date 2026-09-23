/**
 * CalDrop's endpoint.
 *
 * The app is a static page with no server of its own, so this worker is where
 * every decision that is not the user's lives: which model answers, which key
 * pays for it, who is allowed to ask, and how often. The page holds one thing,
 * the access code, because that is the only part that has to differ per person.
 *
 *   POST /v1/chat/completions   proxied to the upstream, model injected here
 *   POST /v1/fetch              { url } -> { text }, so links need no CORS proxy
 *
 * Deploy: see worker/README.md
 */

const DEFAULTS = {
  MODEL: 'gpt-4o-mini',
  DAILY_LIMIT: 20, // requests per IP per day
  MAX_BODY_BYTES: 12 * 1024 * 1024, // a couple of downscaled poster images
  MAX_PAGE_BYTES: 1024 * 1024, // a fetched event page
};

/**
 * What a caller may ask for.
 *
 * The body used to be forwarded wholesale with only the model replaced, which
 * left every cost knob in the caller's hands: n: 20 is twenty answers,
 * max_tokens: 100000 is a hundred thousand of them, and the key paying for it
 * is the operator's. These are the fields the app actually sends; anything
 * else a caller invents is dropped, and the two that scale the bill are
 * capped here rather than trusted.
 */
const FORWARDED = ['messages', 'stream', 'temperature', 'tools', 'tool_choice', 'response_format'];
// Room for a long programme on a model that reasons first: a twenty-row
// rehearsal plan spent 4000 tokens thinking and had written nothing yet.
const MAX_TOKENS_CEILING = 16000;

function askedFor(body, model) {
  const out = { model };
  for (const key of FORWARDED) if (body[key] !== undefined) out[key] = body[key];
  if (body.max_tokens !== undefined) {
    const wanted = Number(body.max_tokens);
    if (Number.isFinite(wanted) && wanted > 0) out.max_tokens = Math.min(wanted, MAX_TOKENS_CEILING);
  }
  return out;
}

/** Does this request attach a picture, in any of the shapes providers use? */
function carriesImage(body) {
  return (body.messages || []).some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((part) => ['image_url', 'image', 'input_image'].includes(part?.type)),
  );
}

const settings = (env) => ({
  model: String(env.MODEL || DEFAULTS.MODEL),
  // Euros per million tokens, so a report can turn a token count into money.
  price: {
    in: Number(env.PRICE_IN || 0),
    out: Number(env.PRICE_OUT || 0),
    visionIn: Number(env.PRICE_VISION_IN || env.PRICE_IN || 0),
    visionOut: Number(env.PRICE_VISION_OUT || env.PRICE_OUT || 0),
  },
  // Falls back to MODEL, so an endpoint whose model reads images needs no
  // second setting and nothing changes for one that never sees a picture.
  visionModel: String(env.VISION_MODEL || env.MODEL || DEFAULTS.MODEL),
  dailyLimit: Number(env.DAILY_LIMIT || DEFAULTS.DAILY_LIMIT),
  maxBodyBytes: Number(env.MAX_BODY_BYTES || DEFAULTS.MAX_BODY_BYTES),
  maxPageBytes: Number(env.MAX_PAGE_BYTES || DEFAULTS.MAX_PAGE_BYTES),
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

/**
 * Compare without leaking the answer through how long it took — including how
 * long the secret is, which a length check answers before any comparison
 * happens. Both sides are hashed first, so every comparison is 32 bytes long
 * whatever was presented.
 */
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function cors(origin, allowed) {
  const ok = originAllowed(origin, allowed) && origin !== '';
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
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

const PRIVATE_HOST =
  /^(localhost|.*\.local|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

/** Read an event page and hand back its text. Doing this here rather than in
 *  the page means no CORS proxy, no third party seeing the links, and one less
 *  thing to configure. */
function privateAddress(url) {
  // new URL() normalises 2130706433 and 0x7f000001 to 127.0.0.1 before this
  // sees them, so the written form of an address is not a way past it.
  return PRIVATE_HOST.test(url.hostname);
}

function readableUrl(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return { error: 'That is not a URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http and https links can be read.' };
  }
  if (privateAddress(url)) return { error: 'That address is not reachable from here.' };
  return { url };
}

/**
 * Read an event page and hand back its text. Doing this here rather than in
 * the page means no CORS proxy, no third party seeing the links, and one less
 * thing to configure.
 *
 * Redirects are followed by hand. Following them automatically checked the
 * address someone typed and then went wherever that address pointed: a public
 * host answering 302 to http://127.0.0.1/ had this endpoint fetch it and hand
 * the contents back, which is a server-side request forgery with the endpoint
 * as the gun. Every hop is checked the same way as the first.
 */
async function fetchPage(target, maxBytes, hops = 5) {
  let next = readableUrl(target);
  if (next.error) return next;
  let url = next.url;

  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          // Some sites serve a different page, or none, without a browser-ish UA.
          'User-Agent': 'Mozilla/5.0 (compatible; CalDrop/1.0; +https://github.com/jibes/cal-drop)',
        },
        redirect: 'manual',
      });
    } catch {
      return { error: 'Could not reach that page.' };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location');
      if (!location) return { error: 'That page redirected to nowhere.' };
      if (hop >= hops) return { error: 'That page redirected too many times.' };
      next = readableUrl(new URL(location, url).toString());
      if (next.error) return next;
      url = next.url;
      continue;
    }

    if (!res.ok) return { error: `That page answered ${res.status}.` };

    // A page, not a download: without this a link to a film is read into
    // memory a megabyte at a time to find no text in it.
    const type = res.headers.get('Content-Type') || '';
    if (type && !/^\s*(text\/|application\/(xhtml\+xml|xml|json))/i.test(type)) {
      return { error: 'That link is not a page this can read.' };
    }

    return { text: htmlToText(await readCapped(res, maxBytes)) };
  }
}

/** The first maxBytes of a body, taken as it arrives: a server is free to
 *  claim a small page and then send for ever. */
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out.slice(0, maxBytes);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Tags, scripts and entities out; the words a reader would see left in. */
function htmlToText(body) {
  return body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Exported so its behaviour can be tested without a network.
/**
 * Call the upstream, keeping the method across redirects.
 *
 * fetch follows redirects by default, and the spec turns a redirected POST
 * into a GET for 301/302/303. An API behind nginx then answers 405 to the GET,
 * which looks like the endpoint rejecting the request rather than a redirect
 * quietly rewriting it. So redirects are handled here, re-issuing the POST.
 */
async function callUpstream(url, init, hops = 3) {
  let target = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return { res, finalUrl: target };

    const location = res.headers.get('Location');
    if (!location || hop >= hops) {
      return { res, finalUrl: target, danglingRedirect: location || '(no Location)' };
    }
    target = new URL(location, target).toString();
  }
}

/** Upstream HTML error pages are unreadable in the UI; reduce them to a line. */
function summarize(detail) {
  const text = /<html|<body/i.test(detail) ? htmlToText(detail) : detail;
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export { htmlToText, summarize };

/** An 8x8 PNG, served over https so a probe can tell "this provider rejects
 *  data: URLs" apart from "this provider rejects images". */
const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mO4Y2OEFTEMLQkAZyhSgVTvwmkAAAAASUVORK5CYII=';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const requestUrl = new URL(request.url);

    /**
     * Serve a calendar file over https, so a phone recognises it and offers to
     * open it in a calendar app. A blob: URL with a download attribute does not
     * get that: it lands in Downloads with nothing willing to handle it.
     *
     * The event travels in the URL and is not stored — it is a few hundred
     * bytes, and storing it would mean deciding when to delete it. Public by
     * necessity: the calendar app follows this link with no headers of ours.
     */
    if (request.method === 'GET' && requestUrl.pathname.endsWith('/ics')) {
      const encoded = requestUrl.searchParams.get('c') || '';
      if (encoded.length > 12000) return json(413, { error: 'Calendar too large for a link' }, headers);

      let text;
      try {
        const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
        text = new TextDecoder().decode(Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)));
      } catch {
        return json(400, { error: 'Unreadable calendar' }, headers);
      }
      // Only ever serve something that is actually a calendar, so this cannot
      // be turned into a way of serving arbitrary content from this origin.
      if (!text.startsWith('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) {
        return json(400, { error: 'Not a calendar' }, headers);
      }

      const name = (requestUrl.searchParams.get('n') || 'event').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
      return new Response(text, {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          // Not "attachment": that is the instruction to download and ask where
          // to save. Inline lets a browser hand the file to whatever opens it.
          'Content-Disposition': `inline; filename="${name || 'event'}.ics"`,
          'Cache-Control': 'no-store',
          ...headers,
        },
      });
    }

    if (request.method === 'GET' && requestUrl.pathname.endsWith('/test-image')) {
      return new Response(Uint8Array.from(atob(TEST_IMAGE), (c) => c.charCodeAt(0)), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ...headers },
      });
    }
    // A browser that is not one of ours is turned away outright. A request with
    // no Origin at all is not a browser, so it is left to the access code below.
    if (origin && !originAllowed(origin, env.ALLOWED_ORIGINS)) {
      return json(403, { error: 'This endpoint does not serve that origin.' }, headers);
    }

    /**
     * The site is public, so anything baked into its bundle is public too —
     * the code has to be something each person enters once and that lives only
     * on their device, or it protects nothing.
     */
    if (env.ACCESS_CODE) {
      const presented = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!(await sameSecret(presented, env.ACCESS_CODE))) {
        return json(401, { error: 'Wrong or missing access code. Enter it in Settings.' }, headers);
      }
    } else if (env.ALLOW_NO_CODE !== 'yes') {
      /**
       * No code set is not a configuration, it is an open door onto someone
       * else's API bill — and it fails silently, because everything works
       * beautifully until the wrong person finds the URL. So it fails closed
       * instead, and an operator who really does want an open endpoint has to
       * say so in as many words.
       */
      return json(
        503,
        {
          error:
            'This endpoint has no access code set, so it is not serving anyone. Its operator must set ' +
            'the ACCESS_CODE secret (or ALLOW_NO_CODE="yes" to run it open on purpose).',
        },
        headers,
      );
    }

    const isChat = requestUrl.pathname.endsWith('/chat/completions');
    const isFetch = requestUrl.pathname.endsWith('/fetch');
    const isModels = requestUrl.pathname.endsWith('/models');
    const isPricing = requestUrl.pathname.endsWith('/pricing');
    const isProbe = requestUrl.pathname.endsWith('/probe');
    if (!isChat && !isFetch && !isModels && !isPricing && !isProbe) {
      return json(404, { error: 'Not found' }, headers);
    }
    if (!isModels && !isPricing && request.method !== 'POST') {
      return json(405, { error: 'POST only' }, headers);
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

    // What this endpoint is configured to use, and what it costs to use it.
    if (isPricing) {
      return json(
        200,
        { model: config.model, visionModel: config.visionModel, currency: 'EUR', perMillionTokens: config.price },
        headers,
      );
    }

    /**
     * What the provider offers, read-only. Without this, choosing a model means
     * reading someone's docs; with it the app can simply show the list.
     */
    if (isModels) {
      try {
        const listed = await fetch(`${env.UPSTREAM_URL || 'https://api.openai.com/v1'}/models`, {
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        });
        const text = await listed.text();
        return new Response(text, {
          status: listed.status,
          headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch {
        return json(502, { error: 'The endpoint could not reach the model provider.' }, headers);
      }
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

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await overQuota(env, ip, config.dailyLimit)) {
      const now = new Date();
      const untilMidnightUtc = Math.ceil(
        (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - Date.now()) / 1000,
      );
      return json(
        429,
        { error: 'Daily limit reached. It resets at midnight UTC.' },
        { ...headers, 'Retry-After': String(untilMidnightUtc) },
      );
    }

    /**
     * Try one named model, for finding out which of a provider's models can do
     * something — reading a picture, say. This is the one place a caller names
     * a model, which is safe because it is behind the access code, capped to a
     * few tokens and counted against the same quota: enough to learn whether a
     * request is accepted, not enough to be worth abusing.
     */
    if (isProbe) {
      const wanted = String(body.model || '').trim();
      if (!wanted) return json(400, { error: 'probe needs a model' }, headers);
      try {
        const { res: tried } = await callUpstream(
          `${env.UPSTREAM_URL || 'https://api.openai.com/v1'}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({ ...askedFor(body, wanted), stream: false, max_tokens: 16 }),
          },
        );
        return new Response(await tried.text(), {
          status: tried.status,
          headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch {
        return json(502, { error: 'The endpoint could not reach the model provider.' }, headers);
      }
    }

    if (isFetch) {
      const result = await fetchPage(String(body.url || ''), config.maxPageBytes);
      return json(result.error ? 400 : 200, result, headers);
    }

    let upstream;
    let finalUrl;
    let danglingRedirect;
    try {
      ({ res: upstream, finalUrl, danglingRedirect } = await callUpstream(
        `${env.UPSTREAM_URL || 'https://api.openai.com/v1'}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          // The model is the operator's decision, not the caller's: whatever
          // the page sent is discarded so there is one answer to "which model".
          // A request carrying pictures may need a different one, since plenty
          // of good text models cannot read an image at all.
          body: JSON.stringify(askedFor(body, carriesImage(body) ? config.visionModel : config.model)),
        },
      ));
    } catch {
      // An uncaught throw here would become a bare 500 with no CORS headers,
      // which a browser cannot read at all — the page would report that its
      // request never left, when in fact this endpoint's upstream is down.
      return json(502, { error: 'The endpoint could not reach the model provider.' }, headers);
    }

    /**
     * An upstream failure is never the caller's to fix — their access code was
     * already checked above — so it must not be passed through as the caller's
     * status. A forwarded 401 in particular would tell the user their access
     * code is wrong when it is the operator's upstream key that was rejected.
     */
    if (!upstream.ok) {
      const detail = summarize(await upstream.text().catch(() => ''));
      const whatHappened =
        upstream.status === 401 || upstream.status === 403
          ? "The model provider rejected this endpoint's key. Its operator needs to check the OPENAI_API_KEY secret."
          : upstream.status === 429
            ? 'The model provider is rate limiting this endpoint. Try again shortly.'
            : danglingRedirect
              ? `The model provider redirected to ${danglingRedirect}, which did not resolve. Check UPSTREAM_URL.`
              : `The model provider answered ${upstream.status}.`;

      /**
       * Statuses the caller can act on keep their meaning. A 400 is how a
       * server without tool-calling support refuses the request, and the app
       * answers it by retrying in plain-JSON mode — fold it into 502 and that
       * retry never happens. Everything else becomes 502, because it is the
       * endpoint or the provider that is broken, not the request.
       */
      const CALLER_ACTIONABLE = [400, 404, 422];
      const status = upstream.status === 429
        ? 429
        : CALLER_ACTIONABLE.includes(upstream.status)
          ? upstream.status
          : 502;

      return json(
        status,
        { error: whatHappened, upstream: { status: upstream.status, url: finalUrl, detail } },
        headers,
      );
    }

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
