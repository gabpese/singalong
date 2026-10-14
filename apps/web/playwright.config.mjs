import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1, // o servidor de teste é um só e guarda o resultado de busca global
  reporter: [['list']],
  use: {
    locale: 'pt-BR', // os testes conferem os textos em português
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      // som sem clique, microfone falso (um tom de teste) sem pedir permissão: a TV precisa dos dois nos testes
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['microphone'],
    // quem entra numa sala sem nome vê o modal que o pede; os testes comuns já chegam com um nome (os do modal limpam isto)
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${PORT}`, localStorage: [{ name: 'userName', value: 'Teste' }] }] },
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT), E2E_PUBLIC: process.env.E2E_PUBLIC ?? 'dist' },
    timeout: 30_000,
  },
});
