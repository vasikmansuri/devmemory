import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { cli: 'src/cli/main.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
