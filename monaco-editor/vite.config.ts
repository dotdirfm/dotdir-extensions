import { defineConfig } from 'vite';

/**
 * Faraday Monaco Editor extension — builds a single ESM bundle that runs inside
 * the host's extension iframe. The host loads this file as script content and
 * executes it in a blob: URL context, so the output must be self-contained.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/entry.ts',
      name: 'FaradayMonacoEditor',
      fileName: 'editor',
//      formats: ['esm'],
      formats: ['iife'],
//      formats: ['cjs'],
    },
    minify: 'esbuild',
    sourcemap: false,
  },
});
