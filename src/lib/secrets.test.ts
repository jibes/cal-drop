import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'caldrop.settings.v1';
let local: Map<string, string>;
let vault: Map<string, string>;

function fakeStore(broken = false) {
  const store = {
    get: vi.fn(async ({ name }: { name: string }) => {
      if (broken) throw new Error('keystore unavailable');
      return { value: vault.get(name) ?? null };
    }),
    set: vi.fn(async ({ name, value }: { name: string; value: string }) => {
      if (value) vault.set(name, value);
      else vault.delete(name);
    }),
    remove: vi.fn(async ({ name }: { name: string }) => void vault.delete(name)),
  };
  vi.stubGlobal('Capacitor', { Plugins: { SecureStore: store } });
  return store;
}

// settings.ts keeps what it read in module state, so each test starts clean.
async function settingsModule() {
  vi.resetModules();
  return import('./settings');
}

beforeEach(() => {
  local = new Map();
  vault = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('settings from the shared endpoint, which is gone', () => {
  it('lose the access code, so Settings asks for an API', async () => {
    local.set(KEY, JSON.stringify({ method: 'proxy', model: '' }));
    vault.set('accessCode', 'code-123');
    fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(s.loadSettings()).toMatchObject({ apiBase: '', apiKey: '' });
    expect(vault.has('accessCode')).toBe(false);
    expect(local.get(KEY)).not.toContain('code-123');
  });

  it('do the same from localStorage, and from the very first shape, the code under apiKey', async () => {
    for (const stored of [{ method: 'proxy', accessCode: 'code-123' }, { apiKey: 'code-123' }]) {
      local.clear();
      vault.clear();
      local.set(KEY, JSON.stringify(stored));
      fakeStore();
      const s = await settingsModule();
      await s.prepareSecrets();
      expect(s.loadSettings()).toMatchObject({ apiBase: '', apiKey: '' });
      expect(local.get(KEY)).not.toContain('code-123');
    }
  });

  it('leave an API of one’s own as it was', async () => {
    local.set(KEY, JSON.stringify({ method: 'direct', apiBase: 'https://api.example.test/v1', model: 'm' }));
    vault.set('apiKey', 'sk-own');
    vault.set('accessCode', 'old-code');
    fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(s.loadSettings()).toMatchObject({ apiBase: 'https://api.example.test/v1', apiKey: 'sk-own', model: 'm' });
    expect(vault.has('accessCode')).toBe(false);
  });

  it('are moved once: today’s settings are never taken for the first shape', async () => {
    const s = await settingsModule();
    s.saveSettings({ ...s.loadSettings(), apiBase: 'https://api.example.test/v1', apiKey: 'sk-browser' });
    expect(s.loadSettings()).toMatchObject({ apiBase: 'https://api.example.test/v1', apiKey: 'sk-browser' });
  });
});

describe('secrets in the app', () => {
  it('saves a key to the store and never to localStorage', async () => {
    const store = fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    s.saveSettings({ ...s.loadSettings(), apiBase: 'https://api.example.test/v1', apiKey: 'sk-secret' });
    await Promise.resolve();
    expect(store.set).toHaveBeenCalledWith({ name: 'apiKey', value: 'sk-secret' });
    expect(local.get(KEY)).not.toContain('sk-secret');
    expect(JSON.parse(local.get(KEY)!)).toMatchObject({ apiBase: 'https://api.example.test/v1' });
  });

  it('works as before when the store fails', async () => {
    local.set(KEY, JSON.stringify({ apiBase: 'https://api.example.test/v1', apiKey: 'sk-1', v: 2 }));
    fakeStore(true);
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(s.secretsAreEncrypted()).toBe(false);
    expect(s.loadSettings().apiKey).toBe('sk-1');
    expect(local.get(KEY)).toContain('sk-1');
  });

  it('clears the store with everything else', async () => {
    vault.set('apiKey', 'sk-secret');
    const store = fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    s.resetSettings();
    expect(store.remove).toHaveBeenCalledWith({ name: 'apiKey' });
    expect(vault.size).toBe(0);
  });
});

describe('secrets in a browser', () => {
  it('stay in localStorage, as Settings says', async () => {
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(s.secretsAreEncrypted()).toBe(false);
    s.saveSettings({ ...s.loadSettings(), apiKey: 'sk-browser' });
    expect(local.get(KEY)).toContain('sk-browser');
  });
});
