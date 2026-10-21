import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1, // there is a single test server, and it keeps a global search result
  reporter: [['list']],
  use: {
    locale: 'pt-BR', // the tests check the Portuguese texts
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      // sound without a click, and a fake microphone (a test tone) without asking for permission: the TV needs both in the tests
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['microphone'],
    // whoever joins a Room without a name sees the dialog asking for it; the usual tests arrive with a name (the dialog's tests clear it)
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${PORT}`, localStorage: [{ name: 'userName', value: 'Teste' }] }] },
  },
  webServer: {
    command: 'node e2e/server.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT), E2E_PUBLIC: process.env.E2E_PUBLIC ?? 'dist' },
    timeout: 30_000,
  },
});
