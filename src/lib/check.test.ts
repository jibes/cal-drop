import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConnection, listModels } from './check';
import type { Settings } from './types';

const own: Settings = {
  method: 'direct',
  accessCode: '',
  apiBase: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  model: 'text-model',
  visionModel: '',
  pageReader: '',
  pageReaderCode: '',
  linkReader: 'off',
  jinaKey: '',
};

const EVENT = {
  events: [
    {
      title: 'Test concert', start_date: '2027-01-03', start_time: '19:30', end_date: '', end_time: '', all_day: false,
      location: 'Tonhalle', timezone: '', rrule: '', description: '', url: '', source_text: 'Sunday 3 January 2027', confidence: 1, notes: '',
    },
  ],
};

function answer(): Response {
  const chunk = { choices: [{ delta: { tool_calls: [{ function: { arguments: JSON.stringify(EVENT) } }] } }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('listModels', () => {
  it('lists what the key may use, sorted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'b' }, { id: 'a' }] })));
    expect(await listModels(own)).toEqual({ ok: true, ids: ['a', 'b'] });
  });

  it('tells a refused key apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    expect(await listModels(own)).toMatchObject({ ok: false, why: 'key' });
  });

  it('tells a provider that refuses browsers from one that is not there', async () => {
    // The browser blocks the readable request; the opaque one gets through.
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }));
    expect(await listModels(own)).toMatchObject({ ok: false, why: 'browser' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await listModels(own)).toMatchObject({ ok: false, why: 'unreachable' });
  });
});

describe('checkConnection', () => {
  it('reports a healthy API line by line, reading the sample text for real', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/models') ? Response.json({ data: [{ id: 'text-model' }] }) : answer())));
    const lines = await checkConnection(own, () => undefined);
    expect(lines.map((l) => [l.label, l.state])).toEqual([
      ['Reach the API', 'ok'],
      ['Read text (text-model)', 'ok'],
      ['Read a photo', 'skip'],
    ]);
    expect(lines[1].detail).toContain('2027-01-03 at 19:30');
  });

  it('stops at a refused key', async () => {
    const fetch = vi.fn(async () => new Response('no', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const lines = await checkConnection(own, () => undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ state: 'fail', detail: 'the key was refused' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('flags a model the provider does not offer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/models') ? Response.json({ data: [{ id: 'other' }] }) : answer())));
    const lines = await checkConnection(own, () => undefined);
    expect(lines.find((l) => l.label === 'Model')).toMatchObject({ state: 'warn' });
  });
});
