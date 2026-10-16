import { expect, test } from '@playwright/test';
import { createRoom } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

test('a entrada tem o título, criar sala e entrar numa sala', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Singalong', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Criar uma festa' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrar em uma sala' })).toBeVisible();
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

test.describe('computador', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: WINDOWS_UA });

  test('o card da festa (grande) ao lado dos de entrar e baixar; a imagem, criar, entrar e baixar estão à vista', async ({ page }) => {
    await page.goto('/');
    const art = page.getByRole('img', { name: /Singalong: um vinil com um microfone/ });
    await expect(art).toBeVisible();
    expect(await art.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true); // a imagem carregou
    const host = await page.locator('.mode-host').boundingBox();
    const join = await page.locator('.mode-join').boundingBox();
    expect(host.x + host.width).toBeLessThanOrEqual(join.x + 1); // criar a festa à esquerda, entrar na sala à direita
    expect(Math.abs(host.y - join.y)).toBeLessThanOrEqual(1); // lado a lado
    expect(host.height).toBeGreaterThanOrEqual(280); // gigantes
    expect(join.height).toBeGreaterThanOrEqual(280);
    const download = await page.locator('.mode-download').boundingBox();
    expect(download.x).toBeGreaterThanOrEqual(join.x - 1); // o card de download fica na coluna da direita, sob o de entrar
    expect(download.y).toBeGreaterThanOrEqual(join.y + join.height - 1);
    await expect(page.getByText('Modo TV')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByLabel('Código da sala')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
  });

  test('o botão do Windows abre o instalador numa nova aba; os outros sistemas ficam sempre à vista, também como botões', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Baixar para Windows', exact: true });
    await expect(link).toHaveAttribute('href', `${BASE}/singalong_karaoke.exe`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const card = page.locator('.download-card');
    await expect(card.getByRole('heading', { name: 'Outros sistemas' })).toBeVisible();
    const mac = card.getByRole('link', { name: 'Baixar para macOS (Apple Silicon)', exact: true });
    const linux = card.getByRole('link', { name: 'Baixar para Linux', exact: true });
    await expect(mac).toHaveAttribute('href', `${BASE}/singalong_karaoke-mac-arm64.dmg`);
    await expect(linux).toHaveAttribute('href', `${BASE}/singalong_karaoke-linux-x86_64.AppImage`);
    for (const button of [link, mac, linux]) {
      await expect(button).toHaveClass(/\bbutton\b/); // todos são botões, do mesmo jeito
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(40);
    }
    await expect(card.getByRole('link', { name: 'Baixar para Windows' })).toHaveCount(1); // o do seu sistema aparece uma vez só (é o primeiro)
    await expect(card.getByRole('link', { name: 'Ver todas as versões' })).toHaveAttribute('href', 'https://example.test/releases/latest');
  });

  test('sem endereço de download configurado, o bloco do app não aparece', async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: { public_url: null, app_download_url: null, app_latest_version: null } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Baixar o app' })).toHaveCount(0);
  });

  test('os botões não mostram a versão que está sendo baixada (o servidor tem uma versão configurada)', async ({ page }) => {
    const config = await (await page.request.get('/api/config')).json();
    expect(config.app_latest_version).toBeTruthy(); // há versão publicada, e mesmo assim ela não aparece
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
    await expect(card).not.toContainText(config.app_latest_version);
    await expect(card).not.toContainText(/\bv\d+\.\d+/);
  });
});

test.describe('celular', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });

  test('a imagem vai em cima e as ações embaixo; no celular o app é explicado em vez de baixado', async ({ page }) => {
    await page.goto('/');
    const art = await page.getByRole('img', { name: /Singalong: um vinil com um microfone/ }).boundingBox();
    const create = await page.getByRole('heading', { name: 'Criar uma festa' }).boundingBox();
    expect(art.y + art.height).toBeLessThanOrEqual(create.y + 1);
    expect(art.width).toBeLessThanOrEqual(390);
    await expect(page.getByText('O app é para computadores com Windows, macOS ou Linux')).toBeVisible();
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: /^Baixar para (Windows|macOS \(Apple Silicon\)|Linux)$/ })).toHaveCount(3); // sem sistema detectado: os três, como botões
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
  await expect(page.getByRole('link', { name: 'Download for Windows', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /vinyl record with a microphone/ })).toBeVisible();
  await context.close();
});

test.describe('Linux', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: LINUX_UA });

  test('o botão é o do AppImage, com a dica de dar permissão, e Windows e macOS ficam abaixo como botões', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: 'Baixar para Linux', exact: true })).toHaveAttribute('href', `${BASE}/singalong_karaoke-linux-x86_64.AppImage`);
    await expect(page.getByText('chmod +x')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Windows', exact: true })).toHaveAttribute('href', `${BASE}/singalong_karaoke.exe`);
    await expect(card.getByRole('link', { name: 'Baixar para macOS (Apple Silicon)', exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Linux' })).toHaveCount(1);
  });
});

const INTEL_TEXT = 'O app não funciona em Macs com processador Intel. Para cantar, não precisa dele: basta criar ou entrar numa sala.';

test.describe('macOS', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: MAC_UA });

  test('o botão do Mac vem direto (sem pergunta), com a dica do Intel ao lado, e a assinatura da Apple é explicada', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByText('Qual é o seu Mac?')).toHaveCount(0); // a pergunta saiu: a dica ao lado do botão faz o papel
    const mac = card.getByRole('link', { name: 'Baixar para macOS (Apple Silicon)', exact: true });
    await expect(mac).toHaveAttribute('href', `${BASE}/singalong_karaoke-mac-arm64.dmg`);
    await expect(card.getByText('clique com o botão direito no app e escolha Abrir')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Linux', exact: true })).toBeVisible();
    // a dica fica ao lado do botão do Mac, na mesma linha
    const tip = card.getByRole('button', { name: 'Sobre o Mac Intel' });
    const [macBox, tipBox] = [await mac.boundingBox(), await tip.boundingBox()];
    expect(tipBox.x).toBeGreaterThanOrEqual(macBox.x + macBox.width - 1);
    expect(Math.abs(tipBox.y + tipBox.height / 2 - (macBox.y + macBox.height / 2))).toBeLessThan(8);
  });

  test('a dica do Intel abre com o mouse, com o foco do teclado e com um clique, e fecha com Esc', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    const tip = card.getByRole('button', { name: 'Sobre o Mac Intel' });
    const text = card.getByRole('tooltip');
    await expect(text).toBeHidden();
    await tip.hover();
    await expect(text).toBeVisible();
    await expect(text).toHaveText(INTEL_TEXT);
    await page.mouse.move(5, 5);
    await expect(text).toBeHidden();
    await tip.focus();
    await expect(text).toBeVisible(); // o teclado também vê a dica
    await page.keyboard.press('Escape');
    await tip.click(); // o toque no celular: não existe "mouse em cima"
    await expect(tip).toHaveAttribute('aria-expanded', 'true');
    await expect(text).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveAttribute('aria-expanded', 'false');
    await expect(tip).toHaveAttribute('aria-describedby', 'mac-tip'); // o leitor de tela lê o texto junto com o botão
  });
});

test.describe('dica do Intel fora do Mac', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: WINDOWS_UA });

  test('quem está no Windows também a vê ao lado do botão do macOS', async ({ page }) => {
    await page.goto('/');
    const tip = page.locator('.download-card').getByRole('button', { name: 'Sobre o Mac Intel' });
    await tip.hover();
    await expect(page.locator('.download-card').getByRole('tooltip')).toHaveText(INTEL_TEXT);
  });
});

test.describe('celular (dica)', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });

  test('no celular a dica cabe na tela e abre com um toque', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await card.getByRole('button', { name: 'Sobre o Mac Intel' }).click();
    const text = card.getByRole('tooltip');
    await expect(text).toBeVisible();
    const box = await text.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
