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
 *   'silent'    nothing answered at all: not deployed, or unreachable
 *   'offline'   the device says it has no network
 */
export type Reach = 'open' | 'refusing' | 'preflight' | 'closed' | 'silent' | 'offline';

export interface Reached {
  reach: Reach;
  /** The status the endpoint answered with, when it answered at all. */
  status?: number;
}

const PUBLIC_GET = () => `${endpoint.replace(/\/+$/, '')}/test-image`;

export async function reachEndpoint(signal?: AbortSignal): Promise<Reached> {
  if (!endpoint) return { reach: 'silent' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { reach: 'offline' };

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
    if (!res.ok) return { reach: 'refusing', status: res.status };

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
    return { reach: 'silent' };
  }
}

/** The same finding, in the words of what to do about it. */
export function describeReach(found: Reached, host: string): string {
  switch (found.reach) {
    case 'offline':
      return 'This device says it is offline, so nothing could be sent.';
    case 'open':
      return `${host} is up and does serve this site, so it was this request it would not take — most likely its size.`;
    case 'refusing':
      return (
        `${host} is answering this site — so this is not about CORS — but it answered with ` +
        `HTTP ${found.status}. That is the endpoint itself, or something in front of it: a limit ` +
        'reached, a key it cannot use, or a crash. Its logs know which.'
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
      return `${host} did not answer at all — it is not deployed, it is down, or this network cannot reach it.`;
  }
}
