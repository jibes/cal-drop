import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, pageReader, saveSettings } from './settings';
import type { Settings } from './types';
import { fetchPageText } from './url';

const own: Settings = {
  apiBase: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  visionModel: '',
  pageReader: '',
  pageReaderCode: '',
  linkReader: 'off',
  jinaKey: '',
};

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('who reads a link', () => {
  it('is nobody with an API of one’s own until a reader is chosen', () => {
    expect(pageReader(own)).toEqual({ kind: 'none' });
  });

  it('is Jina when chosen, with its key', () => {
    expect(pageReader({ ...own, linkReader: 'jina', jinaKey: 'jina_x' })).toEqual({ kind: 'jina', key: 'jina_x' });
  });

  it('is one’s own server when chosen and given', () => {
    const s = { ...own, linkReader: 'server' as const, pageReader: 'https://reader.test/', pageReaderCode: 'c' };
    expect(pageReader(s)).toEqual({ kind: 'server', url: 'https://reader.test', code: 'c' });
    expect(pageReader({ ...s, pageReader: '' })).toEqual({ kind: 'none' });
  });

  it('keeps a server address saved before the choice existed', () => {
    store.set('caldrop.settings.v1', JSON.stringify({ ...own, linkReader: undefined, pageReader: 'https://reader.test' }));
    expect(loadSettings().linkReader).toBe('server');
    store.set('caldrop.settings.v1', JSON.stringify({ ...own, linkReader: undefined }));
    expect(loadSettings().linkReader).toBe('off');
  });
});

describe('reading a link with an API of one’s own', () => {
  it('says plainly that links are off, and sends nothing', async () => {
    saveSettings(own);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchPageText('https://example.com/event', own)).rejects.toThrow(/Links are not read here/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks Jina Reader for the page, with the key when there is one', async () => {
    const s = { ...own, linkReader: 'jina' as const, jinaKey: 'jina_x' };
    saveSettings(s);
    const fetch = vi.fn(async () => new Response('Title: Jazz\n\nFriday 9 October 2026, 20:00', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchPageText('https://example.com/event', s)).resolves.toContain('9 October 2026');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://r.jina.ai/https://example.com/event');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jina_x');
  });

  it('says a dead link is dead, although Jina answers 200', async () => {
    const s = { ...own, linkReader: 'jina' as const };
    saveSettings(s);
    const page =
      'Title: Gone\n\nURL Source: https://example.com/x\n\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nNot here';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page, { status: 200 })));
    await expect(fetchPageText('https://example.com/x', s)).rejects.toThrow(/answered 404/);
  });

  it('explains Jina’s rate limit instead of a status code', async () => {
    const s = { ...own, linkReader: 'jina' as const };
    saveSettings(s);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    await expect(fetchPageText('https://example.com/event', s)).rejects.toThrow(/free limit/);
  });
});

describe('reading a link through a reader of one’s own', () => {
  it('calls it the way Jina is called, with its key and without Jina’s header', async () => {
    const s = { ...own, linkReader: 'server' as const, pageReader: 'https://reader.test/', pageReaderCode: 'c' };
    saveSettings(s);
    const fetch = vi.fn(async () => new Response('Concert, Friday 9 October 2026, 20:00', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchPageText('https://example.com/event?id=3', s)).resolves.toContain('9 October 2026');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://reader.test/https://example.com/event?id=3');
    expect(init.headers).toEqual({ Accept: 'text/plain', Authorization: 'Bearer c' });
  });

  it('passes on what it says when it cannot read the page', async () => {
    const s = { ...own, linkReader: 'server' as const, pageReader: 'https://reader.test' };
    saveSettings(s);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('That address is on a private network.', { status: 400 })));
    await expect(fetchPageText('https://example.com/event', s)).rejects.toThrow(/reader.test could not read that page \(HTTP 400\): That address/);
  });
});
