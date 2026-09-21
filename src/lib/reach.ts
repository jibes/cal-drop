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
 *   'open'    the endpoint answered this origin — so the refusal was about
 *             this particular request, not about the endpoint
 *   'closed'  it answered, but not for this origin: ALLOWED_ORIGINS
 *   'silent'  nothing answered at all: not deployed, or unreachable from here
 *   'offline' the device says it has no network
 */
export type Reach = 'open' | 'closed' | 'silent' | 'offline';

const PUBLIC_GET = () => `${endpoint.replace(/\/+$/, '')}/test-image`;

export async function reachEndpoint(signal?: AbortSignal): Promise<Reach> {
  if (!endpoint) return 'silent';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

  try {
    const res = await fetch(PUBLIC_GET(), { cache: 'no-store', signal });
    if (res.ok) return 'open';
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
    case 'closed':
      return `${host} is answering, but not for ${location.origin}: its ALLOWED_ORIGINS does not list this site.`;
    case 'silent':
    default:
      return `${host} did not answer at all — it is not deployed, it is down, or this network cannot reach it.`;
  }
}
