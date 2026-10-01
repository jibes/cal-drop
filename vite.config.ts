import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works on GitHub Pages (project subpath)
// and inside a Capacitor native WebView.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');

  // An empty VITE_PROXY_URL is what an unset CI variable looks like: it
  // overrides the one committed in .env.production and ships an app without
  // the endpoint it was meant to have. That stays an error. A build meant to
  // have no shared endpoint — own API only, as a public release is — says so
  // in as many words: VITE_PROXY_URL=none.
  if (mode === 'production' && !env.VITE_PROXY_URL?.trim()) {
    throw new Error(
      'VITE_PROXY_URL is empty, so this build would have no endpoint to call.\n' +
        'It is committed in .env.production; an empty environment variable of the\n' +
        'same name overrides it, which is what an unset CI variable looks like.\n' +
        'For a build with no shared endpoint on purpose, set VITE_PROXY_URL=none.',
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
