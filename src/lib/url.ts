import { canReadPagesNatively, readPageNatively } from './native';
import { describeReach, reachEndpoint } from './reach';
import { pageReader, usingOwnApi } from './settings';
import type { Settings } from './types';

/**
 * Read an event page. The browser cannot fetch arbitrary origins, so the
 * endpoint does it: no CORS proxy to configure, and no third party handed the
 * links people paste.
 */
export async function fetchPageText(url: string, settings: Settings): Promise<string> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  const reader = pageReader(settings);

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
    if (reader.kind === 'none') throw refused;
  }

  if (reader.kind === 'none') {
    throw new Error(
      usingOwnApi()
        ? 'Links are not read here: a browser may not fetch another site, and nothing is set up ' +
          'to do it instead. Paste the page\'s text or take a screenshot — or choose a link reader ' +
          'in Settings.'
        : 'This build has no endpoint configured, so links cannot be read.',
    );
  }

  if (reader.kind === 'jina') return readWithJina(target, reader.key);

  const code = reader.code;
  let res: Response;
  try {
    res = await fetch(`${reader.url}/fetch`, {
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
    let host = reader.url;
    try {
      host = new URL(reader.url).host;
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

/** More than any event page needs; the request to the model is cut at 60 000 anyway. */
const MAX_TEXT = 200_000;

/**
 * Jina Reader: a public service that fetches a page and hands back its text,
 * and — unlike a site itself — lets a browser ask. It sees the link, which
 * is why it is only used when chosen. Without a key it is free and rate
 * limited; a key from jina.ai lifts the limit.
 */
async function readWithJina(url: string, key: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: 'text/plain',
        // The words are what the model needs; image links are only noise.
        'X-Retain-Images': 'none',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error('Jina Reader could not be reached. Check the connection, or paste the text instead.');
  }
  const text = await res.text().catch(() => '');
  if (res.status === 429) {
    throw new Error(
      key
        ? 'Jina Reader says this key has used up its limit for now. Try again shortly, or paste the text.'
        : 'Jina Reader’s free limit is used up for now. Try again shortly, add a Jina key in Settings, or paste the text.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Jina Reader refused the key in Settings. Check it, or clear it to use the free tier.');
  }
  if (!res.ok) throw new Error(`Jina Reader could not read that page (HTTP ${res.status}).`);
  // Jina answers 200 for a page that was not there and says so in a line of
  // its own; the error page is no event, so it goes no further.
  const upstream = /^Warning: Target URL returned error (\d{3})/m.exec(text.split('Markdown Content:')[0]);
  if (upstream) throw new Error(`That page answered ${upstream[1]}. Check the link, or paste the text instead.`);
  if (!text.trim()) throw new Error('That page had no readable text. Try a screenshot instead.');
  return text.slice(0, MAX_TEXT);
}
