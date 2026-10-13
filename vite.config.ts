import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { asciiEscape } from './scripts/vite-ascii-escape.mjs';

// エントリは Index.html（GAS 側が 'Index' という名前で読むため大文字 I）。
export default defineConfig({
  plugins: [react(), asciiEscape(), viteSingleFile()],
  build: {
    rollupOptions: { input: 'Index.html' },
    chunkSizeWarningLimit: 4000,
  },
});
