import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works on GitHub Pages (project subpath)
// and inside a Capacitor native WebView.
export default defineConfig({
  base: './',
  plugins: [react()],
  // Shown in Settings: without it, a stale cached copy is indistinguishable
  // from a current one, which is exactly the bug this was added for.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  build: { target: 'es2022' },
});
