import { describeReach, reachEndpoint } from './reach';
import { endpoint } from './settings';
import type { Settings } from './types';

/**
 * Read an event page. The browser cannot fetch arbitrary origins, so the
 * endpoint does it: no CORS proxy to configure, and no third party handed the
 * links people paste.
 */
export async function fetchPageText(url: string, settings: Settings): Promise<string> {
  const target = url.trim();
  if (!endpoint) throw new Error('This build has no endpoint configured, so links cannot be read.');
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  let res: Response;
  try {
    res = await fetch(`${endpoint}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.accessCode.trim() ? { Authorization: `Bearer ${settings.accessCode.trim()}` } : {}),
      },
      body: JSON.stringify({ url: target }),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // Same bare rejection as everywhere else, and the same way of telling the
    // three causes apart rather than listing them.
    let host = endpoint;
    try {
      host = new URL(endpoint).host;
    } catch {
      /* an unconfigured endpoint is its own answer */
    }
    throw new Error(`The request never left the browser.\n${describeReach(await reachEndpoint(), host)}`);
  }

  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `Could not read that page (HTTP ${res.status}).`);
  if (!data.text?.trim()) throw new Error('That page had no readable text. Try a screenshot instead.');
  return data.text;
}
