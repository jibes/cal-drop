import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: Record<string, unknown>) => void;

/** A pretend StreamingHttp plugin that plays back a script of events. */
function plugin(script: (id: string, emit: (event: string, data: Record<string, unknown>) => void) => void) {
  const handlers: Record<string, Handler[]> = {};
  const aborted: string[] = [];
  const emit = (event: string, data: Record<string, unknown>) => handlers[event]?.forEach((h) => h(data));
  const fake = {
    addListener: (event: string, h: Handler) => void (handlers[event] ??= []).push(h),
    request: vi.fn(async ({ id }: { id: string }) => void setTimeout(() => script(id, emit), 0)),
    abort: vi.fn(async ({ id }: { id: string }) => void aborted.push(id)),
  };
  vi.stubGlobal('Capacitor', { Plugins: { StreamingHttp: fake } });
  return { fake, aborted };
}

// native.ts keeps its listeners once wired, so each test gets a fresh module.
async function load() {
  vi.resetModules();
  return import('./native');
}

afterEach(() => vi.unstubAllGlobals());

describe('nativeFetch', () => {
  it('hands back the answer as a stream, piece by piece, letters whole', async () => {
    plugin((id, emit) => {
      emit('head', { id, status: 200, headers: { 'content-type': 'text/event-stream' } });
      emit('chunk', { id, data: 'data: {"a":"Zür' });
      emit('chunk', { id, data: 'ich"}\n\n' });
      emit('end', { id });
    });
    const { nativeFetch } = await load();
    const res = await nativeFetch('https://api.example.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer k' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"a":"Zürich"}\n\n');
  });

  it('passes method, headers and body on to the app', async () => {
    const { fake } = plugin((id, emit) => {
      emit('head', { id, status: 200, headers: {} });
      emit('end', { id });
    });
    const { nativeFetch } = await load();
    await (await nativeFetch('https://x.test/v1/models', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: 'b' })).text();
    expect(fake.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.test/v1/models', method: 'POST', headers: { authorization: 'Bearer k' }, body: 'b' }),
    );
  });

  it('rejects like fetch when nothing answered', async () => {
    plugin((id, emit) => emit('error', { id, message: 'UnknownHostException: nowhere.test' }));
    const { nativeFetch } = await load();
    await expect(nativeFetch('https://nowhere.test/v1/models')).rejects.toThrow(TypeError);
  });

  it('hangs up when the read is cancelled', async () => {
    const { aborted } = plugin((id, emit) => emit('head', { id, status: 200, headers: {} }));
    const { nativeFetch } = await load();
    const controller = new AbortController();
    const res = await nativeFetch('https://x.test/v1/chat/completions', { signal: controller.signal });
    const reading = res.text();
    controller.abort();
    await expect(reading).rejects.toThrow(/Abort/);
    expect(aborted).toHaveLength(1);
  });

  it('gives an error status back as a response the caller can read', async () => {
    plugin((id, emit) => {
      emit('head', { id, status: 401, headers: {} });
      emit('chunk', { id, data: '{"error":{"message":"bad key"}}' });
      emit('end', { id });
    });
    const { nativeFetch } = await load();
    const res = await nativeFetch('https://x.test/v1/models');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: 'bad key' } });
  });
});
