/**
 * Anthropic's Messages API, against a pretend one that answers the way the
 * real one does. Nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEvents } from './ai';
import { toMessagesBody } from './anthropic';
import { listModels } from './check';
import { saveSettings } from './settings';
import type { ExtractionSource, Settings } from './types';

const claude: Settings = {
  apiBase: 'https://api.anthropic.com/v1',
  apiStyle: 'anthropic',
  apiKey: 'sk-ant-test',
  model: 'claude-haiku-4-5',
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

const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A tool call streamed the way the Messages API streams one: its input in pieces. */
function streamed(json = JSON.stringify(EVENT), stop = 'tool_use'): Response {
  const half = Math.floor(json.length / 2);
  const body = sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'save_events', input: {} } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(half) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 120 } },
    { type: 'message_stop' },
  ]);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function api(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : {} });
      return answer(url, init);
    }),
  );
  return calls;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  saveSettings(claude);
});

afterEach(() => vi.unstubAllGlobals());

describe('a request, translated', () => {
  it('moves the system turn out, takes the tool as input_schema, and requires a length', () => {
    const body = toMessagesBody({
      model: 'claude-haiku-4-5',
      stream: true,
      temperature: 0,
      max_completion_tokens: 16000,
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: 'Extract events.' },
        { role: 'user', content: 'A poster' },
      ],
      tools: [{ type: 'function', function: { name: 'save_events', description: 'Save them.', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'save_events' } },
    });
    expect(body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 16000,
      system: 'Extract events.',
      messages: [{ role: 'user', content: 'A poster' }],
      stream: true,
      temperature: 0,
      tools: [{ name: 'save_events', description: 'Save them.', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'save_events' },
    });
  });

  it('sends a photo as its bytes, a link as a link, and names a length where none was asked', () => {
    const body = toMessagesBody({
      model: 'm',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/poster.jpg' } },
          ],
        },
      ],
    });
    expect(body.max_tokens).toBe(8000);
    expect(body).not.toHaveProperty('response_format');
    expect((body.messages as { content: unknown[] }[])[0].content).toEqual([
      { type: 'text', text: 'Read this.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/poster.jpg' } },
    ]);
  });
});

describe('reading with Claude', () => {
  it('asks /messages with its own headers and reads a streamed tool call', async () => {
    const calls = api(() => streamed());
    const events = await extractEvents(source, claude);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: 'Casablanca', startDate: '2026-10-09', startTime: '20:45' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' });
    expect(calls[0].headers).not.toHaveProperty('Authorization');
    expect(calls[0].body).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 16000, tool_choice: { type: 'tool', name: 'save_events' } });
    expect(calls[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('reads an answer that came whole, not streamed', async () => {
    api(() =>
      new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'save_events', input: EVENT }],
          stop_reason: 'tool_use',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const events = await extractEvents(source, claude);
    expect(events[0]).toMatchObject({ title: 'Casablanca' });
  });

  it('says what the API said when it refuses the key', async () => {
    api(() =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status: 401,
      }),
    );
    await expect(extractEvents(source, claude)).rejects.toThrow('invalid x-api-key');
  });

  it('keeps what came through when the answer ran out of room', async () => {
    const two = { events: [EVENT.events[0], { ...EVENT.events[0], title: 'Notorious', start_date: '2026-10-10' }] };
    const cut = JSON.stringify(two).slice(0, -40);
    api(() => streamed(cut, 'max_tokens'));
    const notes: string[] = [];
    const events = await extractEvents(source, claude, { onNote: (n) => notes.push(n) });
    expect(events.map((e) => e.title)).toEqual(['Casablanca']);
    expect(notes[0]).toMatch(/stopped the answer/);
  });
});

describe('the models a Claude key may use', () => {
  it('are asked for with its headers, all of them at once', async () => {
    const calls = api(() => new Response(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-5-5' }] })));
    await expect(listModels(claude)).resolves.toEqual({ ok: true, ids: ['claude-haiku-4-5', 'claude-opus-5-5'] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[0].headers).toMatchObject({ 'x-api-key': 'sk-ant-test' });
  });
});

describe('settings from before there was a choice of style', () => {
  it('speak Anthropic’s dialect when the address is Anthropic’s, and OpenAI’s otherwise', async () => {
    const { loadSettings } = await import('./settings');
    localStorage.setItem('caldrop.settings.v1', JSON.stringify({ v: 2, apiBase: 'https://api.anthropic.com/v1' }));
    expect(loadSettings().apiStyle).toBe('anthropic');
    localStorage.setItem('caldrop.settings.v1', JSON.stringify({ v: 2, apiBase: 'https://api.openai.com/v1' }));
    expect(loadSettings().apiStyle).toBe('openai');
  });
});
