import type { Settings } from './types';

const KEY = 'caldrop.settings.v1';
const env = import.meta.env;

/**
 * Optional shared endpoint (see worker/). When a deployment sets this, the app
 * works with no key at all — the worker holds one — and the key field becomes
 * an opt-in upgrade rather than a wall in front of the first use.
 */
export const sharedEndpoint = ((env.VITE_PROXY_URL as string) || '').trim();

export const defaultSettings: Settings = {
  baseUrl: sharedEndpoint || (env.VITE_AI_BASE_URL as string) || 'https://api.openai.com/v1',
  apiKey: (env.VITE_AI_API_KEY as string) || '',
  model: (env.VITE_AI_MODEL as string) || 'gpt-4o-mini',
  textModel: (env.VITE_AI_TEXT_MODEL as string) || '',
  corsProxy: (env.VITE_CORS_PROXY as string) || 'https://r.jina.ai/{url}',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

/**
 * Store only what the user actually changed. Persisting the whole object would
 * pin every field forever, so a later change to a deployment default — a new
 * shared endpoint, say — could never reach anyone who had opened Settings once.
 */
export function saveSettings(s: Settings): void {
  const changed: Partial<Settings> = {};
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if (s[key] !== defaultSettings[key]) changed[key] = s[key];
  }
  try {
    if (Object.keys(changed).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(changed));
  } catch {
    /* private mode / storage disabled — settings just don't persist */
  }
}

/** Drop every stored override and go back to what this deployment ships with. */
export function resetSettings(): Settings {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored to clear */
  }
  return { ...defaultSettings };
}

export function usingSharedEndpoint(s: Settings): boolean {
  return Boolean(sharedEndpoint) && s.baseUrl.trim() === sharedEndpoint && !s.apiKey.trim();
}

export function isConfigured(s: Settings): boolean {
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  return Boolean(s.apiKey.trim()) || usingSharedEndpoint(s);
}
