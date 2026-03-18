import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      name: 'FaradayFileViewer',
      fileName: 'viewer',
      formats: ['iife'],
    },
    minify: false, //'esbuild',
    sourcemap: false,
  },
});
