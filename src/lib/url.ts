import { endpoint } from './settings';
import type { Settings } from './types';

/**
 * Read an event page. The browser cannot fetch arbitrary origins, so the
 * endpoint does it: no CORS proxy to configure, and no third party handed the
 * links people paste.
 */
export async function fetchPageText(url: string, settings: Settings): Promise<string> {
  const target = url.trim();
  if (!endpoint) throw new Error('This build has no endpoint configured, so links cannot be read.');
  if (!/^https?:\/\//i.test(target)) throw new Error('Enter a full http(s) link.');

  const res = await fetch(`${endpoint}/fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.accessCode.trim() ? { Authorization: `Bearer ${settings.accessCode.trim()}` } : {}),
    },
    body: JSON.stringify({ url: target }),
  });

  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `Could not read that page (HTTP ${res.status}).`);
  if (!data.text?.trim()) throw new Error('That page had no readable text. Try a screenshot instead.');
  return data.text;
}
