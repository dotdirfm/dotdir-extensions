import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      fileName: 'editor',
      formats: ['cjs'],
    },
    minify: 'esbuild',
    sourcemap: false,
  },
});
