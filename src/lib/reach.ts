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
 *   'preflight' a plain GET is served, but the OPTIONS a POST needs is not:
 *               opening the URL in a tab works while the app cannot call it
 *   'closed'    it answered, but not for this origin: ALLOWED_ORIGINS
 *   'silent'    nothing answered at all: not deployed, or unreachable
 *   'offline'   the device says it has no network
 */
export type Reach = 'open' | 'preflight' | 'closed' | 'silent' | 'offline';

const PUBLIC_GET = () => `${endpoint.replace(/\/+$/, '')}/test-image`;

export async function reachEndpoint(signal?: AbortSignal): Promise<Reach> {
  if (!endpoint) return 'silent';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

  try {
    const res = await fetch(PUBLIC_GET(), { cache: 'no-store', signal });
    // A simple GET is served. Everything the app actually sends is a POST
    // carrying a content type and an access code, which the browser will not
    // send until an OPTIONS has been answered — a different question, and the
    // one a tab cannot ask. Any status here means it was answered.
    if (res.ok) {
      try {
        await fetch(`${endpoint.replace(/\/+$/, '')}/pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer preflight-probe' },
          body: '{}',
          cache: 'no-store',
          signal,
        });
        return 'open';
      } catch {
        return 'preflight';
      }
    }
  } catch {
    /* either it is not there, or it is there and will not serve us */
  }

  try {
    // An opaque response is still an answer: something is listening and it
    // replied. Only the reading of it is forbidden.
    await fetch(PUBLIC_GET(), { mode: 'no-cors', cache: 'no-store', signal });
    return 'closed';
  } catch {
    return 'silent';
  }
}

/** The same finding, in the words of what to do about it. */
export function describeReach(reach: Reach, host: string): string {
  switch (reach) {
    case 'offline':
      return 'This device says it is offline, so nothing could be sent.';
    case 'open':
      return `${host} is up and does serve this site, so it was this request it would not take — most likely its size.`;
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
