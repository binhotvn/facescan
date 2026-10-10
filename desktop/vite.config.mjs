import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './': the window loads dist/index.html from disk, not from a server
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
