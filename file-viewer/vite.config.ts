import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      fileName: 'viewer',
      formats: ['cjs'],
    },
    minify: false, //'esbuild',
    sourcemap: false,
  },
});
