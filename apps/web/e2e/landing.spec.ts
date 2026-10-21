import { expect, type Locator, test } from '@playwright/test';
import { createRoom } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

/** The element's box (the test expects it to be on screen). */
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
};

test('the landing page has the title, creating a Room and joining a Room', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Singalong', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Criar uma festa' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrar em uma sala' })).toBeVisible();
  await expect(page).toHaveTitle('Singalong');
});

test('creating a Room opens the TV in another tab and takes the Host to the Room', async ({ page, context }) => {
  await page.goto('/');
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Criar sala e abrir a TV' }).click();
  const tv = await popup;
  await expect(page).toHaveURL(/\/room\.html\?room=[A-Z0-9]{4}$/);
  const code = new URL(page.url()).searchParams.get('room');
  expect(new URL(tv.url()).pathname).toBe('/tv.html');
  expect(new URL(tv.url()).searchParams.get('room')).toBe(code);
  // whoever created it is the Host: the sidebar shows the shortcuts and settings only they have
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copiar link de anfitrião' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir TV' })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Rodízio justo/ })).toBeVisible();
});

test("joining with the code of a Room that exists", async ({ page, request }) => {
  const { code } = await createRoom(request);
  await page.goto('/');
  await page.getByLabel('Código da sala').fill(code.toLowerCase()); // lowercase works too
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(`/room.html?room=${code}`);
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
});

test('a code that does not exist shows the error and stays on the landing page', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Código da sala').fill('ZZZZ');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('status')).toContainText('Não achei a sala ZZZZ');
  await expect(page).toHaveURL(/\/$/);
});

// --- the landing page: the picture on one side, the actions on the other, and the button to download the app ---
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'; // an M1 Mac says "Intel" too
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://example.test/releases/latest/download';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

test.describe('a computer', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: WINDOWS_UA });

  test("the party's card (large) next to joining and downloading; the picture, creating, joining and downloading are in view", async ({ page }) => {
    await page.goto('/');
    const art = page.getByRole('img', { name: /Singalong: um vinil com um microfone/ });
    await expect(art).toBeVisible();
    expect(await art.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true); // the picture loaded
    const host = await boxOf(page.locator('.mode-host'));
    const join = await boxOf(page.locator('.mode-join'));
    expect(host.x + host.width).toBeLessThanOrEqual(join.x + 1); // creating the party on the left, joining a Room on the right
    expect(Math.abs(host.y - join.y)).toBeLessThanOrEqual(1); // side by side
    expect(host.height).toBeGreaterThanOrEqual(280); // giant
    expect(join.height).toBeGreaterThanOrEqual(280);
    const download = await boxOf(page.locator('.mode-download'));
    expect(download.x).toBeGreaterThanOrEqual(join.x - 1); // the download card sits in the right column, under joining
    expect(download.y).toBeGreaterThanOrEqual(join.y + join.height - 1);
    await expect(page.getByText('Modo TV')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByLabel('Código da sala')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
  });

  test("the Windows button opens the installer in a new tab; the other systems are always in view, as buttons too", async ({ page }) => {
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
      await expect(button).toHaveClass(/\bbutton\b/); // they are all buttons, alike
      expect((await boxOf(button)).height).toBeGreaterThanOrEqual(40);
    }
    await expect(card.getByRole('link', { name: 'Baixar para Windows' })).toHaveCount(1); // your system's shows only once (it is the first)
    await expect(card.getByRole('link', { name: 'Ver todas as versões' })).toHaveAttribute('href', 'https://example.test/releases/latest');
  });

  test("without a download address configured, the app's block does not show", async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: { public_url: null, app_download_url: null, app_latest_version: null } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Criar sala e abrir a TV' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Baixar o app' })).toHaveCount(0);
  });

  test('the buttons do not show the version being downloaded (the server has a version configured)', async ({ page }) => {
    const config = await (await page.request.get('/api/config')).json();
    expect(config.app_latest_version).toBeTruthy(); // there is a published version, and it still does not show
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
    await expect(card).not.toContainText(config.app_latest_version);
    await expect(card).not.toContainText(/\bv\d+\.\d+/);
  });
});

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });

  test('the picture goes on top and the actions below; on a phone the app is explained instead of downloaded', async ({ page }) => {
    await page.goto('/');
    const art = await boxOf(page.getByRole('img', { name: /Singalong: um vinil com um microfone/ }));
    const create = await boxOf(page.getByRole('heading', { name: 'Criar uma festa' }));
    expect(art.y + art.height).toBeLessThanOrEqual(create.y + 1);
    expect(art.width).toBeLessThanOrEqual(390);
    await expect(page.getByText('O app é para computadores com Windows, macOS ou Linux')).toBeVisible();
    const card = page.locator('.download-card');
    await expect(card.getByRole('link', { name: /^Baixar para (Windows|macOS \(Apple Silicon\)|Linux)$/ })).toHaveCount(3); // no system detected: all three, as buttons
    await expect(card.getByRole('link', { name: 'Ver todas as versões' })).toHaveAttribute('href', 'https://example.test/releases/latest');
    // nothing overflows to the sides
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("the landing page changes language, the app's block included", async ({ browser }) => {
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

  test("the button is the AppImage's, with the tip about the permission, and Windows and macOS come below as buttons", async ({ page }) => {
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

  test("the Mac's button comes straight away (no question), with the Intel tip beside it, and Apple's signature is explained", async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await expect(card.getByText('Qual é o seu Mac?')).toHaveCount(0); // the question went away: the tip beside the button does its job
    const mac = card.getByRole('link', { name: 'Baixar para macOS (Apple Silicon)', exact: true });
    await expect(mac).toHaveAttribute('href', `${BASE}/singalong_karaoke-mac-arm64.dmg`);
    await expect(card.getByText('clique com o botão direito no app e escolha Abrir')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Windows', exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Baixar para Linux', exact: true })).toBeVisible();
    // the tip sits beside the Mac's button, on the same line
    const tip = card.getByRole('button', { name: 'Sobre o Mac Intel' });
    const [macBox, tipBox] = [await boxOf(mac), await boxOf(tip)];
    expect(tipBox.x).toBeGreaterThanOrEqual(macBox.x + macBox.width - 1);
    expect(Math.abs(tipBox.y + tipBox.height / 2 - (macBox.y + macBox.height / 2))).toBeLessThan(8);
  });

  test("the Intel tip opens with the mouse, with the keyboard's focus and with a click, and closes with Esc", async ({ page }) => {
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
    await expect(text).toBeVisible(); // the keyboard sees the tip too
    await page.keyboard.press('Escape');
    await tip.click(); // a tap on a phone: there is no "mouse over"
    await expect(tip).toHaveAttribute('aria-expanded', 'true');
    await expect(text).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveAttribute('aria-expanded', 'false');
    await expect(tip).toHaveAttribute('aria-describedby', 'mac-tip'); // the screen reader reads the text along with the button
  });
});

test.describe('the Intel tip outside a Mac', () => {
  test.use({ viewport: { width: 1280, height: 720 }, userAgent: WINDOWS_UA });

  test("whoever is on Windows sees it too, beside the macOS button", async ({ page }) => {
    await page.goto('/');
    const tip = page.locator('.download-card').getByRole('button', { name: 'Sobre o Mac Intel' });
    await tip.hover();
    await expect(page.locator('.download-card').getByRole('tooltip')).toHaveText(INTEL_TEXT);
  });
});

test.describe('a phone (the tip)', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });

  test('on a phone the tip fits the screen and opens with a tap', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.download-card');
    await card.getByRole('button', { name: 'Sobre o Mac Intel' }).click();
    const text = card.getByRole('tooltip');
    await expect(text).toBeVisible();
    const box = await boxOf(text);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
