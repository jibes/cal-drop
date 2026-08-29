const SHARE_CACHE = 'caldrop-share';

export interface IncomingShare {
  files: File[];
  text: string;
  url: string;
}

/** Register the worker that makes CalDrop an install target and a share target. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
      scope: new URL('./', document.baseURI).pathname,
    });
  });
}

/**
 * Anything handed to the app from outside: the OS share sheet (parked in a
 * cache by the service worker) or ?url= / ?text= on the address bar, which is
 * what a bookmarklet or an iOS Shortcut can drive.
 */
export async function takeIncoming(): Promise<IncomingShare | null> {
  const params = new URLSearchParams(location.search);
  const shared = params.has('shared');
  const url = params.get('url') ?? '';
  const text = params.get('text') ?? '';

  if (shared || url || text) history.replaceState({}, '', location.pathname);
  if (!shared) return url || text ? { files: [], text, url } : null;

  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const metaResponse = await cache.match('/__share/meta');
  if (!metaResponse) return null;

  const meta = (await metaResponse.json()) as {
    count: number;
    title: string;
    text: string;
    url: string;
  };

  const files: File[] = [];
  for (let i = 0; i < meta.count; i++) {
    const hit = await cache.match(`/__share/file-${i}`);
    if (!hit) continue;
    const blob = await hit.blob();
    const name = decodeURIComponent(hit.headers.get('x-filename') || `shared-${i}`);
    files.push(new File([blob], name, { type: blob.type }));
    await cache.delete(`/__share/file-${i}`);
  }
  await cache.delete('/__share/meta');

  const joined = [meta.title, meta.text].filter(Boolean).join('\n');
  return { files, text: joined, url: meta.url };
}

/** A shared "text" is very often just a link with a word in front of it. */
export function firstUrlIn(value: string): string {
  return /https?:\/\/\S+/.exec(value)?.[0] ?? '';
}
