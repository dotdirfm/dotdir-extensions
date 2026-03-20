import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Some deps (and even React tooling in certain builds) may reference Node globals like `process`.
  // Since extensions run in an iframe browser context, we inline a minimal `process.env.NODE_ENV`.
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{ NODE_ENV: "production" }',
    process: '{ env: { NODE_ENV: "production" } }',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      fileName: 'viewer',
      formats: ['cjs'],
    },
    minify: 'esbuild',
    sourcemap: false,
  },
});
