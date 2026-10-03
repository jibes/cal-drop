import type { ApiStyle } from './types';

/**
 * Providers someone is likely to bring a key for, so that setting one up is
 * picking a name rather than finding a URL. Only the address is known in
 * advance: which models a key may use is the provider's to say, and the app
 * asks it (GET /models) rather than shipping a list that goes out of date.
 *
 * `browser` is whether a web page may call it directly — checked against each
 * one's CORS answer on 2026-09-30. Where it may not, the website says so
 * rather than failing on the first request. Anthropic allows a page that says
 * it means to (anthropic.ts sends that header).
 */
export interface Provider {
  id: string;
  name: string;
  base: string;
  /** Anthropic speaks its own dialect; every other one here speaks OpenAI's. */
  style: ApiStyle;
  /** Where to get a key, for the hint under the key field. */
  keys?: string;
  browser: boolean;
}

export const PROVIDERS: Provider[] = [
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', style: 'openai', keys: 'platform.openai.com/api-keys', browser: true },
  { id: 'anthropic', name: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', style: 'anthropic', keys: 'console.anthropic.com/settings/keys', browser: true },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', style: 'openai', keys: 'openrouter.ai/keys', browser: true },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', style: 'openai', keys: 'console.groq.com/keys', browser: true },
  { id: 'mistral', name: 'Mistral', base: 'https://api.mistral.ai/v1', style: 'openai', keys: 'console.mistral.ai/api-keys', browser: true },
  { id: 'melious', name: 'Melious', base: 'https://api.melious.ai/v1', style: 'openai', keys: 'melious.ai', browser: false },
];

/** The preset an address belongs to, or undefined for one typed by hand. */
export const providerFor = (base: string): Provider | undefined => {
  const clean = base.trim().replace(/\/+$/, '');
  return PROVIDERS.find((p) => p.base === clean);
};
