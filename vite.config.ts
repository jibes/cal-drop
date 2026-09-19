import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works on GitHub Pages (project subpath)
// and inside a Capacitor native WebView.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');

  // A build with no endpoint produces an app that posts to its own origin and
  // fails in a way that looks like anything but a missing setting. It must not
  // be possible to ship one: fail here instead, where the cause is obvious.
  if (mode === 'production' && !env.VITE_PROXY_URL?.trim()) {
    throw new Error(
      'VITE_PROXY_URL is empty, so this build would have no endpoint to call.\n' +
        'It is committed in .env.production; an empty environment variable of the\n' +
        'same name overrides it, which is what an unset CI variable looks like.',
    );
  }

  return {
    base: './',
    plugins: [react()],
    // Shown in Settings: without it, a stale cached copy is indistinguishable
    // from a current one, which is exactly the bug this was added for.
    define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
    build: { target: 'es2022' },
  };
});
