import { canReadPagesNatively, readPageNatively } from './native';
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
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  const reader = proxyEndpoint();

  /**
   * The device reads the page itself where it can. The rule that stops a web
   * page fetching another site is the browser's, and inside the app there is
   * no browser doing the asking — so this is one hop instead of two, works
   * with no endpoint at all, and shows the link to nobody.
   *
   * It is tried first rather than used outright, because the two do not fetch
   * alike: a server's request looks like a browser's and the platform's does
   * not, and sites do turn away what they take for a robot. So the endpoint
   * stays as the second answer where there is one — no page that used to be
   * readable stops being readable, and the failure costs a moment rather than
   * the result.
   */
  let refused: Error | undefined;
  if (canReadPagesNatively()) {
    try {
      const text = await readPageNatively(target);
      if (text.trim()) return text;
      refused = new Error('That page had no readable text. Try a screenshot instead.');
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      refused = err as Error;
    }
    // Nothing came of it and there is nobody else to ask.
    if (!reader) throw refused;
  }

  /**
   * Otherwise it takes a server, and the shared endpoint is the only one this
   * app has. An OpenAI-compatible API has no such route, and a browser may
   * not fetch other origins, so with an API of one's own there is nobody to
   * ask — which is worth saying rather than calling a URL that was never
   * going to be there.
   */
  if (!reader) {
    throw new Error(
      usingOwnApi()
        ? 'Links are read by the shared endpoint, and this app is set to call your own API ' +
          'directly, which has no such thing. Paste the text, take a screenshot, or use the ' +
          'Android app, which reads pages itself.'
        : 'This build has no endpoint configured, so links cannot be read.',
    );
  }

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
