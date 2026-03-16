import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      name: 'FaradayCsvViewer',
      fileName: 'viewer',
      formats: ['iife'],
    },
    minify: 'esbuild',
    sourcemap: false,
  },
});
