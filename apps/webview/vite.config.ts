import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],

  /**
   * Replace Node.js globals that leak into the IIFE bundle via React / other
   * CJS-interop code paths.  Without these, `process is not defined` crashes
   * the bundle at runtime when the HTML is opened in a browser.
   */
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env':          '{}',
    global:                 'globalThis',
  },

  resolve: {
    alias: {
      '@tracegraph/graph-engine': path.resolve(__dirname, '../../packages/graph-engine/src/graph.ts'),
      '@tracegraph/shared-types':  path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
  build: {
    /**
     * IIFE bundle — self-contained, no external imports.
     * The CLI embeds this bundle directly into the HTML output.
     */
    lib: {
      entry:    'src/main.tsx',
      name:     'TraceGraphViewer',
      formats:  ['iife'],
      fileName: () => 'tracegraph-viewer.iife.js',
    },
    outDir:         'dist',
    emptyOutDir:    true,
    /**
     * CSS is inlined into the JS bundle via Vite's inject approach.
     * We set cssCodeSplit:false so a single CSS chunk is produced.
     */
    cssCodeSplit:    false,
    rollupOptions: {
      // No externals — everything is bundled
      external: [],
      output: {
        // Inline CSS into the JS (for truly self-contained embedding)
        assetFileNames: 'tracegraph-viewer.[ext]',
      },
    },
    /**
     * Reasonable size warning threshold for an offline viewer bundle.
     */
    chunkSizeWarningLimit: 2048,
  },
});
