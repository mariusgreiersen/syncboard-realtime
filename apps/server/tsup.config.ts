import { defineConfig } from 'tsup';

export default defineConfig({
  // Flat output: dist/server.js, dist/migrate.js, dist/seed.js (migrations are resolved from ../drizzle).
  entry: { server: 'src/server.ts', migrate: 'src/database/migrate.ts', seed: 'src/database/seed.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Bundle the workspace package (it ships TypeScript source); keep npm dependencies external.
  noExternal: ['@syncboard/shared'],
});
