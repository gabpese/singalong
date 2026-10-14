import { expect, test } from '@playwright/test';
import { createRoom } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

test('a entrada tem o título, criar sala e entrar numa sala', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Singalong', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Criar uma sala' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrar numa sala' })).toBeVisible();
  await expect(page).toHaveTitle('Singalong');
});

test('criar sala abre a TV em outra aba e leva o anfitrião para a sala', async ({ page, context }) => {
  await page.goto('/');
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Criar sala e abrir a TV' }).click();
  const tv = await popup;
  await expect(page).toHaveURL(/\/room\.html\?room=[A-Z0-9]{4}$/);
  const code = new URL(page.url()).searchParams.get('room');
  expect(new URL(tv.url()).pathname).toBe('/tv.html');
  expect(new URL(tv.url()).searchParams.get('room')).toBe(code);
  // quem criou é o anfitrião: a barra lateral mostra os atalhos e ajustes que só ele tem
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copiar link de anfitrião' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir TV' })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Rodízio justo/ })).toBeVisible();
});

test('entrar com o código de uma sala que existe', async ({ page, request }) => {
  const { code } = await createRoom(request);
  await page.goto('/');
  await page.getByLabel('Código da sala').fill(code.toLowerCase()); // minúsculas também valem
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(`/room.html?room=${code}`);
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
});

test('código que não existe mostra o erro e fica na entrada', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Código da sala').fill('ZZZZ');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('status')).toContainText('Não achei a sala ZZZZ');
  await expect(page).toHaveURL(/\/$/);
});

// --- a página inicial: a imagem de um lado, as ações do outro, e o botão de baixar o app ---
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'; // um Mac M1 também diz "Intel"
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://example.test/releases/latest/download';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const downloads = (base) => [
  { system: 'windows', arch: 'x64', file: 'singalong_karaoke.exe', url: `${base}/singalong_karaoke.exe` },
  { system: 'macos', arch: 'arm64', file: 'singalong_karaoke-mac-arm64.dmg', url: `${base}/singalong_karaoke-mac-arm64.dmg` },
  { system: 'linux', arch: 'x64', file: 'singalong_karaoke-linux-x86_64.AppImage', url: `${base}/singalong_karaoke-linux-x86_64.AppImage` },
];
const CONFIG_WITHOUT_VERSION = { public_url: null, app_download_url: 'https://example.test/x/', app_latest_version: null, app_page_url: 'https://example.test/x', app_downloads: downloads('https://example.test/x') };

test.describe('computador', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: WINDOWS_UA });

  test('a imagem fica à esquerda e as ações à direita; criar, entrar e baixar estão à vista', async ({ page }) => {
    await page.goto('/');
    const art = page.getByRole('img', { name: /Singalong: karaokê com a TV/ });
    await expect(art).toBeVisible();
    expect(await art.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true); // a imagem carregou
    const artBox = await art.boundingBox();
    const panelBox = await page.getByRole('heading', { name: 'Criar uma sala' }).boundingBox();
    expect(artBox.x + artBox.width).toBeLessThanOrEqual(panelBox.x + 1); // a imagem termina antes de o painel começar
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByLabel('Código da sala')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar para Windows (v1.2.3)' })).toBeVisible();
  });

  test('o botão do Windows abre o instalador numa nova aba; os outros sistemas ficam sempre à vista', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: /Baixar para Windows/ });
    await expect(link).toHaveAttribute('href', `${BASE}/singalong_karaoke.exe`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const card = page.locator('.download-card');
    await expect(card.getByRole('heading', { name: 'Outros sistemas' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'macOS (Apple Silicon)' })).toHaveAttribute('href', `${BASE}/singalong_karaoke-mac-arm64.dmg`);
    await expect(card.getByRole('link', { name: 'Linux' })).toHaveAttribute('href', `${BASE}/singalong_karaoke-linux-x86_64.AppImage`);
    await expect(card.getByRole('link', { name: 'Windows', exact: true })).toHaveCount(0); // o do seu sistema já é o botão
    await expect(card.getByRole('link', { name: 'Ver todas as versões' })).toHaveAttribute('href', 'https://example.test/releases/latest');
  });

  test('sem endereço de download configurado, o bloco do app não aparece', async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: { public_url: null, app_download_url: null, app_latest_version: null } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Baixar o app' })).toHaveCount(0);
  });

  test('sem a versão, o botão não mostra o número', async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: CONFIG_WITHOUT_VERSION }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
  });
});

test.describe('celular', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });

  test('a imagem vai em cima e as ações embaixo; no celular o app é explicado em vez de baixado', async ({ page }) => {
    await page.goto('/');
    const art = await page.getByRole('img', { name: /Singalong: karaokê com a TV/ }).boundingBox();
    const create = await page.getByRole('heading', { name: 'Criar uma sala' }).boundingBox();
    expect(art.y + art.height).toBeLessThanOrEqual(create.y + 1);
    expect(art.width).toBeLessThanOrEqual(390);
    await expect(page.getByText('O app é para computadores com Windows, macOS ou Linux')).toBeVisible();
    await expect(page.getByRole('link', { name: /Baixar para/ })).toHaveCount(0); // não há botão principal: só a lista, para quem quiser levar o link a um computador
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: /^(Windows|macOS \(Apple Silicon\)|Linux)$/ })).toHaveCount(3);
    await expect(card.getByRole('link', { name: 'Ver todas as versões' })).toHaveAttribute('href', 'https://example.test/releases/latest');
    // nada transborda para os lados
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test('a página inicial muda de idioma, inclusive o bloco do app', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', userAgent: WINDOWS_UA, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Download the app' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download for Windows (v1.2.3)' })).toBeVisible();
  await expect(page.getByRole('img', { name: /karaoke with the TV/ })).toBeVisible();
  await context.close();
});

test.describe('Linux', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: LINUX_UA });

  test('o botão é o do AppImage, com a dica de dar permissão, e Windows e macOS ficam na lista', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Baixar para Linux (v1.2.3)' })).toHaveAttribute('href', `${BASE}/singalong_karaoke-linux-x86_64.AppImage`);
    await expect(page.getByText('chmod +x')).toBeVisible();
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: 'Windows', exact: true })).toHaveAttribute('href', `${BASE}/singalong_karaoke.exe`);
    await expect(card.getByRole('link', { name: 'macOS (Apple Silicon)' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Linux', exact: true })).toHaveCount(0);
  });
});

test.describe('macOS', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: MAC_UA });

  test('o navegador não sabe se o Mac é Intel: a pessoa responde, e só o Apple Silicon recebe o DMG', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByText('Qual é o seu Mac?')).toBeVisible();
    await expect(card.getByRole('link', { name: /Baixar para macOS/ })).toHaveCount(0); // antes de responder não há arquivo
    // Intel: a explicação, nenhum arquivo
    await card.getByRole('button', { name: 'Intel' }).click();
    await expect(card.getByRole('button', { name: 'Intel' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByText('O app não funciona em Macs com processador Intel').first()).toBeVisible();
    await expect(card.getByRole('link', { name: /Baixar para macOS/ })).toHaveCount(0);
    // Apple Silicon: o DMG e o aviso sobre a assinatura
    await card.getByRole('button', { name: 'Apple Silicon (M1 ou mais novo)' }).click();
    await expect(card.getByRole('link', { name: 'Baixar para macOS (Apple Silicon) (v1.2.3)' })).toHaveAttribute('href', `${BASE}/singalong_karaoke-mac-arm64.dmg`);
    await expect(card.getByText('clique com o botão direito no app e escolha Abrir')).toBeVisible();
    // Windows e Linux continuam na lista
    await expect(card.getByRole('link', { name: 'Windows', exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Linux', exact: true })).toBeVisible();
  });
});
