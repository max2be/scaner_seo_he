import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: Object.fromEntries(['contracts', 'core', 'sources', 'storage', 'reports']
    .map(name => [`@hsi/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))])) },
  test: { include: ['tests/**/*.test.ts'], maxWorkers: 2 },
});
