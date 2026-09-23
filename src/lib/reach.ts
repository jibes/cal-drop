import { endpoint } from './settings';

/**
 * Why a request never left the browser.
 *
 * fetch() rejects with the same bare TypeError whether the host is down, the
 * device is offline, or the server answered a preflight the browser did not
 * like — and the console keeps the real reason to itself. But the endpoint
 * serves one public GET with no custom headers, which needs no preflight, and
 * the same URL can be asked for twice: once normally, once with CORS turned
 * off. The pair of answers separates the three cases.
 *
 *   'open'      the endpoint answers this origin, preflight included — so the
 *               refusal was about that particular request
 *   'refusing'  it answered this origin and the answer was an error: the
 *               endpoint or what is in front of it, never CORS
 *   'preflight' a plain GET is served, but the OPTIONS a POST needs is not:
 *               opening the URL in a tab works while the app cannot call it
 *   'closed'    it answered, but not for this origin: ALLOWED_ORIGINS
 *   'silent'    nothing answered at all, while this device's own network is
 *               working: not deployed, down, or blocked on the way out
 *   'offline'   the device has no working network, so nothing can be said
 *               about the endpoint at all
 */
export type Reach = 'open' | 'refusing' | 'preflight' | 'closed' | 'silent' | 'offline';

export interface Reached {
  reach: Reach;
  /** The status the endpoint answered with, when it answered at all. */
  status?: number;
  /** The first line of that answer — the error's own words, when it had any. */
  said?: string;
}

const PUBLIC_GET = () => `${endpoint.replace(/\/+$/, '')}/test-image`;

/**
 * What an error answer says, in one line. A worker's own refusals are short
 * sentences or small JSON; what sits in front of one answers in an HTML page,
 * which says nothing worth repeating and is skipped.
 */
async function firstLine(res: Response): Promise<string | undefined> {
  if ((res.headers.get('content-type') || '').includes('html')) return undefined;
  try {
    const body = (await res.text()).slice(0, 600).trim();
    if (!body || body.startsWith('<')) return undefined;
    let said = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      const found = typeof parsed.error === 'string' ? parsed.error : parsed.message;
      if (typeof found === 'string' && found.trim()) said = found.trim();
    } catch {
      /* not JSON, so the text itself is the message */
    }
    said = said.split('\n')[0].trim();
    return said ? said.slice(0, 160) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is this device's network working at all?
 *
 * The page itself is served from somewhere, and that somewhere can be asked.
 * A POST is used rather than a GET for two reasons: the service worker hands
 * back the cached shell for a same-origin GET it cannot fetch, which would
 * answer the wrong question entirely, and it ignores anything that is not a
 * GET — so a POST goes to the network untouched. What is answered does not
 * matter; GitHub Pages says 405. That it answered is the whole point.
 */
async function ownNetworkWorks(signal: AbortSignal): Promise<boolean> {
  if (typeof location === 'undefined') return true;
  try {
    await fetch(location.href, { method: 'POST', cache: 'no-store', signal });
    return true;
  } catch {
    return false;
  }
}

/** How long a probe is given before the silence is taken as the answer. */
const PROBE_MS = 8000;

export async function reachEndpoint(): Promise<Reached> {
  if (!endpoint) return { reach: 'silent' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { reach: 'offline' };

  /**
   * On its own signal, deliberately. This runs to explain a request that was
   * just cancelled or that died, and a diagnosis the failure itself can
   * cancel reports silence and means "I was aborted" — which is how a working
   * endpoint came to be called down.
   */
  const own = new AbortController();
  const signal = own.signal;
  const timer = setTimeout(() => own.abort(), PROBE_MS);
  try {
    return await ask(signal);
  } finally {
    clearTimeout(timer);
  }
}

async function ask(signal: AbortSignal): Promise<Reached> {
  try {
    const res = await fetch(PUBLIC_GET(), { cache: 'no-store', signal });

    /**
     * Reading that status at all is the finding: a browser hands back a
     * response only when the origin was allowed, whatever the number is. This
     * used to ask whether the status was 2xx, so a rate limit, a crash or an
     * error page from whatever sits in front of the endpoint fell through to
     * the no-cors question below — which always succeeds — and the app then
     * accused an innocent ALLOWED_ORIGINS of the whole thing.
     */
    if (!res.ok) return { reach: 'refusing', status: res.status, said: await firstLine(res) };

    // Everything the app actually sends is a POST carrying a content type and
    // an access code, which the browser will not send until an OPTIONS has
    // been answered — a different question, and the one a tab cannot ask.
    try {
      await fetch(`${endpoint.replace(/\/+$/, '')}/pricing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer preflight-probe' },
        body: '{}',
        cache: 'no-store',
        signal,
      });
      return { reach: 'open' };
    } catch {
      return { reach: 'preflight' };
    }
  } catch {
    /* either it is not there, or it is there and will not serve us */
  }

  try {
    // An opaque response is still an answer: something is listening and it
    // replied. Only the reading of it is forbidden.
    await fetch(PUBLIC_GET(), { mode: 'no-cors', cache: 'no-store', signal });
    return { reach: 'closed' };
  } catch {
    // Nothing came back either way. Before that is laid at the endpoint's
    // door, ask whether anything at all can be reached from here.
    return { reach: (await ownNetworkWorks(signal)) ? 'silent' : 'offline' };
  }
}

/** The same finding, in the words of what to do about it. */
export function describeReach(found: Reached, host: string): string {
  switch (found.reach) {
    case 'offline':
      return (
        'This device has no working connection right now — not even the page it is running from ' +
        'can be reached. Nothing can be said about the endpoint until that is back.'
      );
    case 'open':
      return (
        `${host} is up and serves this site — checked just now — so it is neither down nor a ` +
        'question of which origins it allows. The browser refused to send this particular ' +
        'request.'
      );
    case 'refusing':
      return (
        `${host} is answering this site — so this is not about CORS — but it answered with ` +
        `HTTP ${found.status}${found.said ? `: “${found.said}”` : ''}. That is the endpoint itself, ` +
        'or something in front of it: a limit reached, a key it cannot use, or a crash.' +
        (found.said ? '' : ' Its logs know which.')
      );
    case 'preflight':
      return (
        `${host} serves a plain request from this site — which is why the URL opens in a browser tab — ` +
        'but it refuses the OPTIONS the browser sends before a POST. Either the endpoint is not returning ' +
        'Access-Control-Allow-Headers for Content-Type and Authorization, or something in front of it is ' +
        'answering OPTIONS itself.'
      );
    case 'closed':
      return `${host} is answering, but not for ${location.origin}: its ALLOWED_ORIGINS does not list this site.`;
    case 'silent':
    default:
      return (
        `${host} did not answer at all, though this device's connection is working — so it is ` +
        'the endpoint: not deployed, down, or something between here and it dropping the request. ' +
        'Opening its URL in a browser tab settles which.'
      );
  }
}
