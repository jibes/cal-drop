/**
 * The whole read, against a pretend API that refuses parameters the way real
 * ones do. Nothing leaves the machine: fetch is replaced for each test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEvents } from './ai';
import { saveSettings } from './settings';
import type { ExtractionSource, Settings } from './types';

const own: Settings = {
  apiBase: 'https://api.example.test/v1',
  apiStyle: 'openai',
  apiKey: 'sk-test',
  model: 'test-model',
  visionModel: '',
  pageReader: '',
  pageReaderCode: '',
  linkReader: 'off',
  jinaKey: '',
};

const source: ExtractionSource = {
  kind: 'text',
  label: 'pasted text',
  images: [],
  text: 'Open Air Kino: Casablanca, Friday 9 October 2026 at 20:45, Landiwiese Zürich',
};

const EVENT = {
  events: [
    {
      title: 'Casablanca',
      start_date: '2026-10-09',
      start_time: '20:45',
      end_date: '',
      end_time: '',
      all_day: false,
      location: 'Landiwiese Zürich',
      timezone: 'Europe/Zurich',
      rrule: '',
      description: '',
      url: '',
      source_text: 'Friday 9 October 2026 at 20:45',
      confidence: 1,
      notes: '',
    },
  ],
};

/** A streamed tool call carrying the answer, as an OpenAI-style server sends it. */
function answer(): Response {
  const chunk = { choices: [{ delta: { tool_calls: [{ function: { arguments: JSON.stringify(EVENT) } }] } }] };
  const done = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const refuse = (param: string, message: string) =>
  new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', param } }), { status: 400 });

/** A pretend API: refuses what `rules` says, answers otherwise, and keeps every body it was sent. */
function api(rules: (body: Record<string, unknown>) => Response | null) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return rules(body) ?? answer();
  });
  vi.stubGlobal('fetch', fetch);
  return bodies;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  saveSettings(own);
});

afterEach(() => vi.unstubAllGlobals());

describe('an API of one’s own', () => {
  it('asks in the current standard, without thinking at length', async () => {
    const bodies = api(() => null);
    const events = await extractEvents(source, own);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: 'Casablanca', startTime: '20:45', location: 'Landiwiese Zürich' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'test-model', max_completion_tokens: 16000, temperature: 0, reasoning_effort: 'none' });
    expect(bodies[0].max_tokens).toBeUndefined();
  });

  it('meets an OpenAI reasoning model: no temperature, and "low" where "none" is refused', async () => {
    const bodies = api((b) => {
      if (b.temperature !== undefined) return refuse('temperature', "Unsupported value: 'temperature' does not support 0 with this model.");
      if (b.reasoning_effort === 'none') return refuse('reasoning_effort', "Invalid value: 'none'. Supported values are: 'low', 'medium', and 'high'.");
      return null;
    });
    const events = await extractEvents(source, own);
    expect(events).toHaveLength(1);
    const last = bodies.at(-1)!;
    expect(last.temperature).toBeUndefined();
    expect(last.reasoning_effort).toBe('low');
    // Same way of asking throughout: a refused parameter is not a refused rung.
    expect(bodies.every((b) => Array.isArray(b.tools))).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('meets an older server: max_tokens instead, and no reasoning_effort at all', async () => {
    const bodies = api((b) => {
      if (b.max_completion_tokens !== undefined) return refuse('', 'Unrecognized request argument supplied: max_completion_tokens');
      if (b.reasoning_effort !== undefined) return refuse('', 'Unrecognized request argument supplied: reasoning_effort');
      return null;
    });
    const events = await extractEvents(source, own);
    expect(events).toHaveLength(1);
    expect(bodies.at(-1)).toMatchObject({ max_tokens: 16000 });
    expect(bodies.at(-1)!.reasoning_effort).toBeUndefined();
  });

  it('remembers what it learned, so the next read asks right the first time', async () => {
    api((b) => (b.reasoning_effort === 'none' ? refuse('reasoning_effort', "Invalid value: 'none'.") : null));
    await extractEvents(source, own);
    const again = api((b) => (b.reasoning_effort === 'none' ? refuse('reasoning_effort', "Invalid value: 'none'.") : null));
    await extractEvents(source, own);
    expect(again).toHaveLength(1);
    expect(again[0].reasoning_effort).toBe('low');
  });

  it('still reports a refusal that no parameter explains', async () => {
    api(() => new Response(JSON.stringify({ error: { message: 'Model not found: test-model' } }), { status: 404 }));
    await expect(extractEvents(source, own)).rejects.toThrow(/Model not found/);
  });
});
