import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:5200';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact()],
  css: { modules: { localsConvention: 'camelCaseOnly' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One JS and one CSS file, so the static export can inline them.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000,
    modulePreload: false,
  },
  server: {
    port: 5201,
    proxy: { '/r/': api, '/generate': api, '/export': api, '/vendor': api, '/mcp': api },
  },
});
