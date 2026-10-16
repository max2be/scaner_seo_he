import { defineConfig } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
const certificate = new X509Certificate(readFileSync('tests/fixtures/tls/fixture.crt'));
const spki = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  outputDir: 'test-results',
  reporter: 'list',
  use: {
    baseURL: 'https://127.0.0.1:4178',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      args: ['--ignore-certificate-errors-spki-list=' + spki],
    },
  },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    port: 4178,
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
