import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{ NODE_ENV: "production" }',
    process: '{ env: { NODE_ENV: "production" } }',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep this extension self-contained (inline wasm as data: URL).
    assetsInlineLimit: 10_000_000,
    lib: {
      entry: 'src/entry.ts',
      fileName: 'editor',
      formats: ['cjs'],
    },
    minify: 'esbuild',
    sourcemap: false,
  },
});

