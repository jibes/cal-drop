import type { Settings } from './types';

const KEY = 'caldrop.settings.v1';

/** The endpoint this build talks to. Set at deploy time; see worker/. */
export const endpoint = ((import.meta.env.VITE_PROXY_URL as string) || '').trim().replace(/\/+$/, '');

export const defaultSettings: Settings = { accessCode: '' };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const stored = JSON.parse(raw) as Partial<Settings> & { apiKey?: string };
    // Older builds stored the code in a field called apiKey.
    return { accessCode: (stored.accessCode ?? stored.apiKey ?? '').trim() };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  try {
    if (s.accessCode.trim()) localStorage.setItem(KEY, JSON.stringify({ accessCode: s.accessCode.trim() }));
    else localStorage.removeItem(KEY);
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
  return { ...defaultSettings };
}

/** Host shown in Settings, so what the app talks to is never a guess. */
export function endpointHost(): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint || 'not configured';
  }
}
