const SHARE_CACHE = 'caldrop-share';

export interface IncomingShare {
  files: File[];
  text: string;
  url: string;
}

/** Register the worker that makes CalDrop an install target and a share target. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // A worker that claims the page mid-session leaves the old bundle running,
  // so a deploy would not reach anyone until they cleared their cache by hand.
  // Reload once when a NEW worker takes over — not on the first registration,
  // where claiming is expected and there is nothing stale to replace.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI), {
        scope: new URL('./', document.baseURI).pathname,
      })
      .then((registration) => registration.update())
      .catch(() => {
        /* no service worker is survivable; the app still works online */
      });
  });
}

/**
 * What the native shell was handed by the rest of the phone: the share sheet,
 * "open with", or the text-selection menu. A browser has no such plugin and
 * this is simply nothing.
 */
interface SharedFile {
  name: string;
  type: string;
  data: string;
}

interface ShareTarget {
  consume(): Promise<{ text?: string; title?: string; files?: SharedFile[] }>;
  addListener(
    event: 'shared',
    handler: (payload: { text?: string; title?: string; files?: SharedFile[] }) => void,
  ): unknown;
}

const shareTarget = (): ShareTarget | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { ShareTarget?: ShareTarget } } }).Capacitor?.Plugins
    ?.ShareTarget;

/** Bytes as a File, because that is what every way in already takes. */
function toFile(file: SharedFile): File | null {
  try {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], file.name || 'shared', { type: file.type });
  } catch {
    return null;
  }
}

function fromNative(payload: {
  text?: string;
  title?: string;
  files?: SharedFile[];
}): IncomingShare | null {
  const files = (payload.files ?? []).map(toFile).filter((f): f is File => f !== null);
  const text = [payload.title, payload.text].filter(Boolean).join('\n').trim();
  if (files.length === 0 && !text) return null;
  // A share is overwhelmingly a link with a word in front of it; the caller
  // decides what to do with text either way, so it travels as text.
  return { files, text, url: '' };
}

/**
 * Whatever the phone hands over while the app is already open — a second
 * poster shared right after the first. Without this it would sit in the
 * plugin unread, because the page only collects once, on load.
 */
export function onShared(handler: (incoming: IncomingShare) => void): void {
  // Through Capacitor.Plugins, addListener hands back a callback id rather
  // than a promise, so it is wrapped before anything is chained on it.
  try {
    const listening = shareTarget()?.addListener('shared', (payload) => {
      const incoming = fromNative(payload);
      if (incoming) handler(incoming);
    });
    void Promise.resolve(listening).catch(() => {
      /* an older shell without the plugin simply never calls back */
    });
  } catch {
    /* same: no listener, nothing to hand over */
  }
}

/**
 * Anything handed to the app from outside: the native share target, the OS
 * share sheet in a browser (parked in a cache by the service worker), or
 * ?url= / ?text= on the address bar, which is what a bookmarklet or an iOS
 * Shortcut can drive.
 */
export async function takeIncoming(): Promise<IncomingShare | null> {
  try {
    const waiting = await shareTarget()?.consume();
    if (waiting) {
      const incoming = fromNative(waiting);
      if (incoming) return incoming;
    }
  } catch {
    /* the shell is there but said nothing usable; the web paths still apply */
  }

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
