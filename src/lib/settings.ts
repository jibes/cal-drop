import type { LinkReader, Settings } from './types';

const KEY = 'caldrop.settings.v1';

export const defaultSettings: Settings = {
  apiBase: '',
  apiKey: '',
  model: '',
  visionModel: '',
  pageReader: '',
  pageReaderCode: '',
  // Off until someone chooses a service that will see their links.
  linkReader: 'off',
  jinaKey: '',
};

/**
 * What is configured right now.
 *
 * Which host the app talks to is no longer fixed at build time, and the
 * places that need to know — the reach probe, the link reader, the calendar
 * link — are not handed the settings and have no business taking them as
 * arguments. So the answer is kept here, where it is written exactly twice:
 * when the settings are read at startup and when they are saved.
 */
let inForce: Settings = { ...defaultSettings };

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

// ---- secrets ----

/**
 * The fields that are worth something to whoever reads them: a key spends
 * money, a reader's code lets someone else use it. In the app they are kept in the
 * phone's keystore-encrypted store (SecureStore, see cal-drop-app), not in
 * localStorage, which is a plain file in the app's data. A browser has no
 * such store, and there they stay where they were — which Settings says.
 */
const SECRETS = ['apiKey', 'jinaKey', 'pageReaderCode'] as const;
type Secret = (typeof SECRETS)[number];

interface SecureStore {
  get(o: { name: string }): Promise<{ value: string | null }>;
  set(o: { name: string; value: string }): Promise<void>;
  remove(o: { name: string }): Promise<void>;
}

const secureStore = (): SecureStore | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { SecureStore?: SecureStore } } }).Capacitor?.Plugins?.SecureStore;

/** The secrets as the secure store holds them; null where there is no such store. */
let secrets: Record<Secret, string> | null = null;

/** Whether the secrets are kept in the phone's encrypted store rather than localStorage. */
export const secretsAreEncrypted = (): boolean => secrets !== null;

/**
 * Read the secrets before anything else reads the settings — called once, at
 * startup, before the first screen. Anything still in localStorage from an
 * earlier build moves into the encrypted store and is removed from there, so
 * nobody has to type their code again. If the store fails, the settings work
 * as they always did.
 */
export async function prepareSecrets(): Promise<void> {
  const store = secureStore();
  if (!store) return;
  try {
    const found = {} as Record<Secret, string>;
    for (const name of SECRETS) found[name] = (await store.get({ name })).value ?? '';

    // An access code kept by an earlier build opened the shared endpoint,
    // which is gone; it opens nothing now.
    await store.remove({ name: 'accessCode' });

    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = upgraded(JSON.parse(raw) as Record<string, unknown>);
      let moved = false;
      for (const name of SECRETS) {
        const value = clean(stored[name]);
        if (value && !found[name]) {
          await store.set({ name, value });
          found[name] = value;
        }
        if (name in stored) {
          delete stored[name];
          moved = true;
        }
      }
      // Only once every value is safely in the store does it leave localStorage.
      if (moved || raw !== JSON.stringify(stored)) localStorage.setItem(KEY, JSON.stringify(stored));
    }
    secrets = found;
  } catch {
    secrets = null;
  }
}

/** Marks settings in today's shape, so they are never taken for an older one. */
const SHAPE = 2;

/**
 * Whatever an earlier build stored, in today's shape. Earlier builds could
 * call a shared endpoint with an access code — the first ones kept the code
 * under apiKey and stored no method at all, later ones said 'proxy' or
 * 'direct'. The endpoint is gone, so a code is dropped; only 'direct' was
 * already an API of one's own, and stays as it was.
 */
function upgraded(stored: Record<string, unknown>): Record<string, unknown> {
  if (stored.v === SHAPE) return stored;
  const out: Record<string, unknown> = { ...stored, v: SHAPE };
  if (stored.method === undefined) delete out.apiKey;
  delete out.method;
  delete out.accessCode;
  return out;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (inForce = { ...defaultSettings, ...(secrets ?? {}) });
    const stored = upgraded(JSON.parse(raw) as Record<string, unknown>) as Partial<Settings>;
    const settings: Settings = {
      apiBase: clean(stored.apiBase).replace(/\/+$/, ''),
      apiKey: clean(stored.apiKey),
      model: clean(stored.model),
      visionModel: clean(stored.visionModel),
      pageReader: clean(stored.pageReader).replace(/\/+$/, ''),
      pageReaderCode: clean(stored.pageReaderCode),
      // Settings from before the choice existed: a reader address means
      // that server was the choice.
      linkReader: (['off', 'jina', 'server'] as LinkReader[]).includes(stored.linkReader as LinkReader)
        ? (stored.linkReader as LinkReader)
        : clean(stored.pageReader)
          ? 'server'
          : 'off',
      jinaKey: clean(stored.jinaKey),
    };
    if (secrets) Object.assign(settings, secrets);
    return (inForce = settings);
  } catch {
    return (inForce = { ...defaultSettings, ...(secrets ?? {}) });
  }
}

/** Nothing anyone chose — so nothing is stored. */
const empty = (s: Settings): boolean =>
  !s.apiBase.trim() &&
  !s.apiKey.trim() &&
  !s.pageReader.trim() &&
  !s.pageReaderCode.trim() &&
  s.linkReader === 'off' &&
  !s.jinaKey.trim() &&
  !s.model.trim() &&
  !s.visionModel.trim();

export function saveSettings(s: Settings): void {
  const settings: Settings = {
    apiBase: s.apiBase.trim().replace(/\/+$/, ''),
    apiKey: s.apiKey.trim(),
    model: s.model.trim(),
    visionModel: s.visionModel.trim(),
    pageReader: s.pageReader.trim().replace(/\/+$/, ''),
    pageReaderCode: s.pageReaderCode.trim(),
    linkReader: s.linkReader,
    jinaKey: s.jinaKey.trim(),
  };
  inForce = settings;

  // In the app the secrets go to the encrypted store and nowhere else.
  let plain: Partial<Settings> = settings;
  const store = secureStore();
  if (secrets && store) {
    const held = secrets;
    for (const name of SECRETS) {
      if (held[name] !== settings[name]) {
        held[name] = settings[name];
        void store.set({ name, value: settings[name] }).catch(() => undefined);
      }
    }
    plain = { ...settings };
    for (const name of SECRETS) delete plain[name];
  }
  try {
    if (empty(settings)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ v: SHAPE, ...plain }));
  } catch {
    /* private mode / storage disabled — settings just don't persist */
  }
}

export function resetSettings(): Settings {
  const store = secureStore();
  if (secrets && store) {
    for (const name of SECRETS) {
      secrets[name] = '';
      void store.remove({ name }).catch(() => undefined);
    }
    void store.remove({ name: 'accessCode' }).catch(() => undefined);
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored to clear */
  }
  return (inForce = { ...defaultSettings });
}

export const settingsInForce = (): Settings => inForce;

/**
 * Where a chat request goes. An OpenAI-compatible base is given as far as
 * /v1, and the path is added like any client would.
 */
export function activeEndpoint(s: Settings = inForce): string {
  return s.apiBase.trim().replace(/\/+$/, '');
}

/** What goes in the Authorization header. */
export const authSecret = (s: Settings = inForce): string => s.apiKey.trim();

/**
 * Which model to ask for.
 *
 * Two can be named, because one model rarely does both well and several do
 * only one at all: the text model reads a pasted programme, and a picture
 * goes to whichever model accepts pictures. Naming only one is a perfectly
 * good answer where the same model reads both.
 */
export const wantedModel = (forImage = false, s: Settings = inForce): string => {
  const vision = s.visionModel.trim();
  return forImage && vision ? vision : s.model.trim();
};

/**
 * Who reads a link in a browser, and what to present when asking: whatever
 * was chosen, and by default nobody — a link is a thing a service gets to see.
 */
export type PageReader =
  | { kind: 'none' }
  | { kind: 'jina'; key: string }
  | { kind: 'server'; url: string; code: string };

export function pageReader(s: Settings = inForce): PageReader {
  const server = s.pageReader.trim().replace(/\/+$/, '');
  if (s.linkReader === 'jina') return { kind: 'jina', key: s.jinaKey.trim() };
  if (s.linkReader === 'server' && server) return { kind: 'server', url: server, code: s.pageReaderCode.trim() };
  return { kind: 'none' };
}

/** Host shown in Settings, so what the app talks to is never a guess. */
export function endpointHost(s: Settings = inForce): string {
  const url = activeEndpoint(s);
  try {
    return new URL(url).host;
  } catch {
    return url || 'not configured';
  }
}

/**
 * Run something as if these settings were in force, without saving them —
 * so that "Test connection" tries what is on the screen, through the same
 * code a real read takes, before anyone has pressed Save.
 */
export async function trying<T>(s: Settings, run: () => Promise<T>): Promise<T> {
  const before = inForce;
  inForce = s;
  try {
    return await run();
  } finally {
    inForce = before;
  }
}
