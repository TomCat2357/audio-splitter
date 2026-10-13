import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { asciiEscape } from './scripts/vite-ascii-escape.mjs';

// エントリは Vite の既定（リポジトリ直下の index.html）。出力は dist/index.html の 1 枚で、GAS 側は 'index' という名前で読む。
export default defineConfig({
  plugins: [react(), asciiEscape(), viteSingleFile()],
  build: {
    chunkSizeWarningLimit: 4000,
  },
});
