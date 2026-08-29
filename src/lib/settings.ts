import type { Settings } from './types';

const KEY = 'caldrop.settings.v1';

const env = import.meta.env;

export const defaultSettings: Settings = {
  baseUrl: (env.VITE_AI_BASE_URL as string) || 'https://api.openai.com/v1',
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

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage disabled — settings just don't persist */
  }
}

export function isConfigured(s: Settings): boolean {
  return Boolean(s.baseUrl.trim() && s.apiKey.trim() && s.model.trim());
}
