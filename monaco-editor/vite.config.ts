import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: 'src/entry.ts',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'editor.mjs',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
    minify: 'esbuild',
    sourcemap: false,
  },
  worker: {
    format: 'iife',
  },
});
