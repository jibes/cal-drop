/**
 * Reading a web page, for a worker.
 *
 * Shared by the two workers that do it — the endpoint, which reads a page on
 * the way to asking a model about it, and the fetcher, which only reads. The
 * protections here are the whole reason this is one file rather than two
 * copies: a page fetcher is a server that makes requests on a stranger's
 * say-so, and the ways that goes wrong are the same wherever it runs.
 */

const PRIVATE_HOST =
  /^(localhost|.*\.local|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

/** Read an event page and hand back its text. Doing this here rather than in
 *  the page means no CORS proxy, no third party seeing the links, and one less
 *  thing to configure. */
function privateAddress(url) {
  // new URL() normalises 2130706433 and 0x7f000001 to 127.0.0.1 before this
  // sees them, so the written form of an address is not a way past it.
  return PRIVATE_HOST.test(url.hostname);
}

function readableUrl(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return { error: 'That is not a URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http and https links can be read.' };
  }
  if (privateAddress(url)) return { error: 'That address is not reachable from here.' };
  return { url };
}

/**
 * Read an event page and hand back its text. Doing this here rather than in
 * the page means no CORS proxy, no third party seeing the links, and one less
 * thing to configure.
 *
 * Redirects are followed by hand. Following them automatically checked the
 * address someone typed and then went wherever that address pointed: a public
 * host answering 302 to http://127.0.0.1/ had this endpoint fetch it and hand
 * the contents back, which is a server-side request forgery with the endpoint
 * as the gun. Every hop is checked the same way as the first.
 */
async function fetchPage(target, maxBytes, hops = 5) {
  let next = readableUrl(target);
  if (next.error) return next;
  let url = next.url;

  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          // Some sites serve a different page, or none, without a browser-ish UA.
          'User-Agent': 'Mozilla/5.0 (compatible; CalDrop/1.0; +https://github.com/jibes/cal-drop)',
        },
        redirect: 'manual',
      });
    } catch {
      return { error: 'Could not reach that page.' };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location');
      if (!location) return { error: 'That page redirected to nowhere.' };
      if (hop >= hops) return { error: 'That page redirected too many times.' };
      next = readableUrl(new URL(location, url).toString());
      if (next.error) return next;
      url = next.url;
      continue;
    }

    if (!res.ok) return { error: `That page answered ${res.status}.` };

    // A page, not a download: without this a link to a film is read into
    // memory a megabyte at a time to find no text in it.
    const type = res.headers.get('Content-Type') || '';
    if (type && !/^\s*(text\/|application\/(xhtml\+xml|xml|json))/i.test(type)) {
      return { error: 'That link is not a page this can read.' };
    }

    return { text: htmlToText(await readCapped(res, maxBytes)) };
  }
}

/** The first maxBytes of a body, taken as it arrives: a server is free to
 *  claim a small page and then send for ever. */
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out.slice(0, maxBytes);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Tags, scripts and entities out; the words a reader would see left in. */
function htmlToText(body) {
  return body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { fetchPage, htmlToText, readableUrl };
