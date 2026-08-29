import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works on GitHub Pages (project subpath)
// and inside a Capacitor native WebView.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022' },
});
