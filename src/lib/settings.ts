import type { LinkReader, Settings } from './types';

const KEY = 'caldrop.settings.v1';

/** The shared endpoint this build was given. Set at deploy time; see worker/. */
/** "none" builds an app with no shared endpoint on purpose: own API only, as a public release is. */
const configuredProxy = ((import.meta.env.VITE_PROXY_URL as string) || '').trim();
export const proxyUrl = configuredProxy === 'none' ? '' : configuredProxy.replace(/\/+$/, '');

/** Kept for the many places that only ever meant the shared endpoint. */
export const endpoint = proxyUrl;

/**
 * What to ask for before anyone has said otherwise.
 *
 * These are the two models the shared endpoint is configured with — see
 * MODEL and VISION_MODEL in worker/wrangler.toml — so pointing the app at the
 * relay in front of the same provider works without first having to know
 * what to type. They are a starting point and nothing more: an API of one's
 * own is somebody else's, and both fields are there to be changed.
 */
// Only where there is a shared endpoint whose provider these are; a public
// build knows nothing of anyone's provider, and the list comes from theirs.
const DEFAULT_MODEL = proxyUrl ? 'gemma-4-31b' : '';
const DEFAULT_VISION_MODEL = proxyUrl ? 'gemma-3-27b-it' : '';

export const defaultSettings: Settings = {
  method: proxyUrl ? 'proxy' : 'direct',
  accessCode: '',
  apiBase: '',
  apiKey: '',
  model: DEFAULT_MODEL,
  visionModel: DEFAULT_VISION_MODEL,
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
 * money, a code lets someone else spend it. In the app they are kept in the
 * phone's keystore-encrypted store (SecureStore, see cal-drop-app), not in
 * localStorage, which is a plain file in the app's data. A browser has no
 * such store, and there they stay where they were — which Settings says.
 */
const SECRETS = ['accessCode', 'apiKey', 'jinaKey', 'pageReaderCode'] as const;
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

    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      // Older builds kept the access code under apiKey, with no method at all.
      if (stored.method === undefined && clean(stored.apiKey) && !clean(stored.accessCode)) {
        stored.accessCode = stored.apiKey;
        stored.apiKey = '';
      }
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
      if (moved) localStorage.setItem(KEY, JSON.stringify(stored));
    }
    secrets = found;
  } catch {
    secrets = null;
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (inForce = { ...defaultSettings, ...(secrets ?? {}) });
    const stored = JSON.parse(raw) as Partial<Settings> & { apiKey?: string };
    // Older builds stored the access code in a field called apiKey, and knew
    // of no method at all — those settings are a proxy's, whatever they hold.
    const legacy = stored.method === undefined;
    const settings: Settings = {
      method: stored.method === 'direct' ? 'direct' : 'proxy',
      accessCode: clean(stored.accessCode) || (legacy ? clean(stored.apiKey) : ''),
      apiBase: clean(stored.apiBase).replace(/\/+$/, ''),
      apiKey: legacy ? '' : clean(stored.apiKey),
      // Absent and empty are different answers: a field that was never
      // stored takes the default, one deliberately cleared stays cleared.
      model: stored.model === undefined ? DEFAULT_MODEL : clean(stored.model),
      visionModel: stored.visionModel === undefined ? DEFAULT_VISION_MODEL : clean(stored.visionModel),
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

/** Nothing worth storing at all — so nothing is stored. */
/** Nothing anyone chose — only what this build starts with. */
const empty = (s: Settings): boolean =>
  !s.accessCode.trim() &&
  !s.apiBase.trim() &&
  !s.apiKey.trim() &&
  !s.pageReader.trim() &&
  !s.pageReaderCode.trim() &&
  s.linkReader === 'off' &&
  !s.jinaKey.trim() &&
  s.model.trim() === DEFAULT_MODEL &&
  s.visionModel.trim() === DEFAULT_VISION_MODEL;

export function saveSettings(s: Settings): void {
  const settings: Settings = {
    method: s.method,
    accessCode: s.accessCode.trim(),
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
    if (empty(settings) && settings.method === defaultSettings.method) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(plain));
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
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored to clear */
  }
  return (inForce = { ...defaultSettings });
}

export const settingsInForce = (): Settings => inForce;

export const usingOwnApi = (s: Settings = inForce): boolean => s.method === 'direct';

/**
 * Where a chat request goes. An OpenAI-compatible base is given as far as
 * /v1, and the path is added like any client would.
 */
export function activeEndpoint(s: Settings = inForce): string {
  return usingOwnApi(s) ? s.apiBase.trim().replace(/\/+$/, '') : proxyUrl;
}

/**
 * The shared endpoint, when it is the one in use.
 *
 * Reading a link, and handing a phone a calendar over https, are things the
 * endpoint does besides passing on chat requests. Somebody's own OpenAI API
 * has no such routes, so this is empty there and those features say so
 * rather than calling a URL that was never going to answer.
 */
export function proxyEndpoint(s: Settings = inForce): string {
  return usingOwnApi(s) ? '' : proxyUrl;
}

/** Whatever goes in the Authorization header: an access code, or a real key. */
export const authSecret = (s: Settings = inForce): string =>
  (usingOwnApi(s) ? s.apiKey : s.accessCode).trim();

/**
 * Which model to ask for, or '' to let the endpoint decide.
 *
 * Two are needed, because one model rarely does both well and several do only
 * one at all: the text model reads a pasted programme, and a picture goes to
 * whichever model accepts pictures. The shared endpoint makes that choice
 * itself — it is half of what it is for — so it is asked for nothing; with an
 * API of one's own there is nobody else to decide. Naming only one is a
 * perfectly good answer where the same model reads both.
 */
export const wantedModel = (forImage = false, s: Settings = inForce): string => {
  if (!usingOwnApi(s)) return '';
  const vision = s.visionModel.trim();
  return forImage && vision ? vision : s.model.trim();
};

/**
 * Who reads a link when the device cannot, and what to present when asking.
 *
 * With the shared endpoint it reads links itself, as it always has — unless a
 * server of one's own was given, which is the only reader that exists in
 * every arrangement. With an API of one's own it is whatever was chosen, and
 * by default nobody: a link is a thing a service gets to see.
 */
export type PageReader =
  | { kind: 'none' }
  | { kind: 'jina'; key: string }
  | { kind: 'server'; url: string; code: string };

export function pageReader(s: Settings = inForce): PageReader {
  const server = s.pageReader.trim().replace(/\/+$/, '');
  if (usingOwnApi(s)) {
    if (s.linkReader === 'jina') return { kind: 'jina', key: s.jinaKey.trim() };
    if (s.linkReader === 'server' && server) return { kind: 'server', url: server, code: s.pageReaderCode.trim() };
    return { kind: 'none' };
  }
  if (server) return { kind: 'server', url: server, code: s.pageReaderCode.trim() };
  const shared = proxyEndpoint(s);
  return shared ? { kind: 'server', url: shared, code: authSecret(s) } : { kind: 'none' };
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
