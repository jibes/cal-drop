/** Fetch an event page's text. Browsers can't fetch arbitrary origins because
 *  of CORS, so we go through the configured proxy. In a Capacitor native build
 *  there is no CORS, and a direct fetch is tried first. */
export async function fetchPageText(url: string, proxyTemplate: string): Promise<string> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) URL.');

  const direct = await tryFetch(target);
  if (direct) return direct;

  if (!proxyTemplate.trim()) {
    throw new Error(
      'The browser blocked the request (CORS) and no proxy is configured. Set one in Settings, or paste the page text instead.',
    );
  }
  const proxied = proxyTemplate.includes('{url}')
    ? proxyTemplate.replace('{url}', encodeURIComponent(target))
    : proxyTemplate + target;

  const viaProxy = await tryFetch(proxied);
  if (viaProxy) return viaProxy;

  throw new Error('Could not load that page. Paste its text or a screenshot instead.');
}

async function tryFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html,text/plain,*/*' } });
    if (!res.ok) return null;
    const body = await res.text();
    return htmlToText(body).slice(0, 60000);
  } catch {
    return null;
  }
}

function htmlToText(body: string): string {
  if (!/<html|<body|<div|<p[\s>]/i.test(body)) return body.trim();
  const doc = new DOMParser().parseFromString(body, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
  return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
