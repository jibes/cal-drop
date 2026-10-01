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
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('secrets in the app', () => {
  it('moves an access code out of localStorage into the encrypted store', async () => {
    local.set(KEY, JSON.stringify({ method: 'proxy', accessCode: 'code-123', model: 'm' }));
    fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(vault.get('accessCode')).toBe('code-123');
    expect(JSON.parse(local.get(KEY)!)).not.toHaveProperty('accessCode');
    expect(s.loadSettings().accessCode).toBe('code-123');
    expect(s.secretsAreEncrypted()).toBe(true);
  });

  it('moves the very old shape too, where the access code sat under apiKey', async () => {
    local.set(KEY, JSON.stringify({ apiKey: 'old-code' }));
    fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(vault.get('accessCode')).toBe('old-code');
    expect(vault.has('apiKey')).toBe(false);
    expect(s.loadSettings()).toMatchObject({ accessCode: 'old-code', apiKey: '' });
  });

  it('saves a key to the store and never to localStorage', async () => {
    const store = fakeStore();
    const s = await settingsModule();
    await s.prepareSecrets();
    s.saveSettings({ ...s.loadSettings(), method: 'direct', apiBase: 'https://api.example.test/v1', apiKey: 'sk-secret' });
    await Promise.resolve();
    expect(store.set).toHaveBeenCalledWith({ name: 'apiKey', value: 'sk-secret' });
    expect(local.get(KEY)).not.toContain('sk-secret');
    expect(JSON.parse(local.get(KEY)!)).toMatchObject({ method: 'direct', apiBase: 'https://api.example.test/v1' });
  });

  it('works as before when the store fails', async () => {
    local.set(KEY, JSON.stringify({ method: 'proxy', accessCode: 'code-123' }));
    fakeStore(true);
    const s = await settingsModule();
    await s.prepareSecrets();
    expect(s.secretsAreEncrypted()).toBe(false);
    expect(s.loadSettings().accessCode).toBe('code-123');
    expect(local.get(KEY)).toContain('code-123');
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
    s.saveSettings({ ...s.loadSettings(), method: 'direct', apiKey: 'sk-browser' });
    expect(local.get(KEY)).toContain('sk-browser');
  });
});
