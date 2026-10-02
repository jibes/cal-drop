import { canReadPagesNatively, readPageNatively } from './native';
import { pageReader } from './settings';
import type { Settings } from './types';

/**
 * Read an event page.
 *
 * In the app the phone reads it itself. The rule that stops a web page
 * fetching another site is the browser's, and inside the app there is no
 * browser doing the asking — so it takes no service, and shows the link to
 * nobody.
 *
 * A browser has to ask someone, and asks whoever was chosen in Settings:
 * Jina Reader, or a reader of one's own that is called the same way. Nobody,
 * until one is chosen.
 */
export async function fetchPageText(url: string, settings: Settings): Promise<string> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  if (canReadPagesNatively()) {
    const text = await readPageNatively(target);
    if (!text.trim()) throw new Error('That page had no readable text. Try a screenshot instead.');
    return text;
  }

  const reader = pageReader(settings);
  if (reader.kind === 'none') {
    throw new Error(
      'Links are not read here: a browser may not fetch another site, and nothing is set up ' +
        "to do it instead. Paste the page's text or take a screenshot — or choose a link reader " +
        'in Settings.',
    );
  }
  return reader.kind === 'jina'
    ? readThrough(JINA, target, reader.key, 'Jina Reader')
    : readThrough(reader.url, target, reader.code, readerName(reader.url));
}

const JINA = 'https://r.jina.ai';

const readerName = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return 'The link reader';
  }
};

/** More than any event page needs; the request to the model is cut at 60 000 anyway. */
const MAX_TEXT = 200_000;

/**
 * Ask a reader for a page: GET <reader>/<link>, answered with the page's
 * text. That is how Jina Reader is called — a public service that fetches a
 * page and, unlike a site itself, lets a browser ask — and a reader of one's
 * own (fetcher/ is one) is called exactly the same way, so both take the same
 * road here. A reader sees the link, which is why one is only used when
 * chosen. Jina is free and rate limited without a key; a key lifts the limit.
 */
async function readThrough(base: string, url: string, key: string, name: string): Promise<string> {
  const jina = base === JINA;
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/${url}`, {
      headers: {
        Accept: 'text/plain',
        // The words are what the model needs; image links are only noise.
        // Jina's own header, so it goes only to Jina: anything else would
        // have to allow it before a browser would send the request at all.
        ...(jina ? { 'X-Retain-Images': 'none' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`${name} could not be reached. Check the connection, or paste the text instead.`);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 429) {
    throw new Error(
      key || !jina
        ? `${name} says the limit is used up for now. Try again shortly, or paste the text.`
        : 'Jina Reader’s free limit is used up for now. Try again shortly, add a Jina key in Settings, or paste the text.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      jina
        ? 'Jina Reader refused the key in Settings. Check it, or clear it to use the free tier.'
        : `${name} refused the code in Settings. Check it.`,
    );
  }
  if (!res.ok) {
    const said = text.trim().split('\n')[0].slice(0, 200);
    throw new Error(`${name} could not read that page (HTTP ${res.status})${said && !said.startsWith('<') ? `: ${said}` : '.'}`);
  }
  // Jina answers 200 for a page that was not there and says so in a line of
  // its own; the error page is no event, so it goes no further.
  const upstream = /^Warning: Target URL returned error (\d{3})/m.exec(text.split('Markdown Content:')[0]);
  if (upstream) throw new Error(`That page answered ${upstream[1]}. Check the link, or paste the text instead.`);
  if (!text.trim()) throw new Error('That page had no readable text. Try a screenshot instead.');
  return text.slice(0, MAX_TEXT);
}
