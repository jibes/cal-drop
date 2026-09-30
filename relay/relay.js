/**
 * CalDrop relay — an OpenAI-compatible API, made callable from a browser.
 *
 * The other worker in this repository is an endpoint: it holds the API key,
 * decides the model, and asks for an access code. This one holds nothing. It
 * exists for a single reason — a hosted inference API answers no CORS
 * preflight, so a web page may not call it however valid the key is — and it
 * removes exactly that obstacle and nothing else.
 *
 * So the caller's Authorization header is passed through untouched, and a
 * request without one is refused here rather than forwarded. That is what
 * keeps this from being an open relay: it buys nobody any compute. Whoever
 * uses it spends their own key, as if they had called the upstream directly,
 * which is what the browser would not let them do.
 *
 * Put its URL, ending in /v1, into Settings → My own API.
 */

const DEFAULT_UPSTREAM = 'https://api.melious.ai/v1';

/** Headers that belong to one hop and must not be carried to the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // The caller's own cookies are none of the upstream's business, and the
  // upstream's are none of the page's.
  'cookie',
  'cookie2',
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env, request);
    if (!cors) return new Response('Origin not allowed', { status: 403 });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const upstream = target(request, env);
    if (!upstream) return json(404, { error: 'No such path on this relay.' }, cors);

    // Held by nobody here. A request that carries no key is not forwarded:
    // this relay lends no credentials, so an unauthenticated call could only
    // ever be someone using it to reach the upstream anonymously.
    if (!request.headers.get('Authorization')) {
      return json(401, { error: 'This relay carries no key of its own. Send yours.' }, cors);
    }

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    }
    // The upstream is being asked as a client, not as this origin.
    headers.delete('origin');
    headers.delete('referer');

    let answer;
    try {
      answer = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        // Required by the standard whenever a body is a stream, which this
        // one is: it is the caller's body, handed on without being read.
        // Workers forgives its absence and other runtimes refuse outright.
        duplex: 'half',
        redirect: 'follow',
      });
    } catch (unreachable) {
      return json(502, { error: `The upstream could not be reached: ${unreachable.message}` }, cors);
    }

    /**
     * The body is handed on as it arrives rather than read first. Extraction
     * is streamed — the app shows events as they are written — and buffering
     * here would turn that into one long silence followed by everything.
     */
    const out = new Headers(cors);
    for (const [name, value] of answer.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') {
        out.set(name, value);
      }
    }
    return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: out });
  },
};

/**
 * Where a request is forwarded to.
 *
 * The upstream is fixed in configuration, so this is never a proxy to
 * wherever the caller fancies. The path is what came after this worker's own
 * /v1, rebuilt onto the upstream's base — and rebuilt through URL, so a path
 * that tries to climb out with .. resolves before it is used and cannot
 * escape the base.
 */
function target(request, env) {
  const base = (env.UPSTREAM_URL || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const asked = new URL(request.url);
  const after = asked.pathname.replace(/^\/+v1\/?/, '');
  if (!after) return '';
  const built = new URL(after, `${base}/`);
  if (!built.href.startsWith(`${base}/`)) return '';
  built.search = asked.search;
  return built.href;
}

/**
 * Who may call this.
 *
 * "*" is the point of the thing — an API of one's own is useful from anywhere
 * one happens to be — but it is a variable, so a deployment that wants to be
 * narrower says so. Null means the origin is not welcome.
 */
function corsHeaders(origin, env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((o) => o.trim()).filter(Boolean);
  const open = allowed.includes('*');
  if (!open && origin && !allowed.includes(origin)) return null;

  // Echoed rather than listed: the browser states what it intends to send,
  // and anything this relay would forward anyway may as well be allowed.
  const asked = request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': open ? origin || '*' : origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': asked || 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
