import type { Settings } from './types';

const KEY = 'caldrop.settings.v1';

/** The shared endpoint this build was given. Set at deploy time; see worker/. */
export const proxyUrl = ((import.meta.env.VITE_PROXY_URL as string) || '').trim().replace(/\/+$/, '');

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
const DEFAULT_MODEL = 'gemma-4-31b';
const DEFAULT_VISION_MODEL = 'gemma-3-27b-it';

export const defaultSettings: Settings = {
  method: proxyUrl ? 'proxy' : 'direct',
  accessCode: '',
  apiBase: '',
  apiKey: '',
  model: DEFAULT_MODEL,
  visionModel: DEFAULT_VISION_MODEL,
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

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (inForce = { ...defaultSettings });
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
    };
    return (inForce = settings);
  } catch {
    return (inForce = { ...defaultSettings });
  }
}

/** Nothing worth storing at all — so nothing is stored. */
/** Nothing anyone chose — only what this build starts with. */
const empty = (s: Settings): boolean =>
  !s.accessCode.trim() &&
  !s.apiBase.trim() &&
  !s.apiKey.trim() &&
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
  };
  inForce = settings;
  try {
    if (empty(settings) && settings.method === defaultSettings.method) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode / storage disabled — settings just don't persist */
  }
}

export function resetSettings(): Settings {
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

/** Host shown in Settings, so what the app talks to is never a guess. */
export function endpointHost(s: Settings = inForce): string {
  const url = activeEndpoint(s);
  try {
    return new URL(url).host;
  } catch {
    return url || 'not configured';
  }
}
