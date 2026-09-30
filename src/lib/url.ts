import { describeReach, reachEndpoint } from './reach';
import { authSecret, proxyEndpoint, usingOwnApi } from './settings';
import type { Settings } from './types';

/**
 * Read an event page. The browser cannot fetch arbitrary origins, so the
 * endpoint does it: no CORS proxy to configure, and no third party handed the
 * links people paste.
 */
export async function fetchPageText(url: string, settings: Settings): Promise<string> {
  const target = url.trim();
  const reader = proxyEndpoint();
  /**
   * Reading a page is not something an OpenAI-compatible API does. The
   * browser cannot do it either — it may not fetch other origins — so with
   * an API of one's own there is nobody to ask, and saying so beats calling
   * a route that was never going to be there.
   */
  if (!reader) {
    throw new Error(
      usingOwnApi()
        ? 'Links are read by the shared endpoint, and this app is set to call your own API ' +
          'directly, which has no such thing. Paste the text, or take a screenshot of the page.'
        : 'This build has no endpoint configured, so links cannot be read.',
    );
  }
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  const code = authSecret(settings);
  let res: Response;
  try {
    res = await fetch(`${reader}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(code ? { Authorization: `Bearer ${code}` } : {}),
      },
      body: JSON.stringify({ url: target }),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // Same bare rejection as everywhere else, and the same way of telling the
    // three causes apart rather than listing them.
    let host = reader;
    try {
      host = new URL(reader).host;
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
