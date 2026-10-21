// The administrator's page: publishing the app's version and its message (it holds at once for the apps), seeing who is out of
// date, and going back to the .env.
import { expect, type Page, test } from '@playwright/test';
import { AxeBuilder } from './helpers.ts';

const ADMIN_PAGE = '/e2e-painel-secreto-0123456789/';
const TOKEN = 'e2e-admin';

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  // puts the test server back to what the .env says (the other tests' landing page depends on it)
  await request.delete(`${ADMIN_PAGE}api/release`, { headers: { 'x-admin-token': TOKEN } });
});

async function logIn(page: Page) {
  await page.goto(ADMIN_PAGE);
  await page.getByLabel('Token de administrador').fill(TOKEN);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Versão do app' })).toBeVisible();
}

test('the page shows the version from the .env and lets another be published, with its message; it holds at once', async ({ page, request }) => {
  await logIn(page);
  await expect(page.locator('#release-source')).toHaveText('vem do .env');
  await expect(page.getByLabel('Versão mais recente')).toHaveValue('1.2.3');
  await expect(page.locator('#rel-clear')).toBeHidden(); // nothing published here yet: nothing to clear

  // the preview follows what is typed
  await page.getByLabel('Mensagem da versão (o que mudou)').fill('Corrige a pontuação e melhora o guia.');
  await expect(page.locator('#prev-notes')).toHaveText('Corrige a pontuação e melhora o guia.');
  await expect(page.locator('#prev-title')).toHaveText('Há uma versão nova: 1.2.3');
  await expect(page.locator('#prev-required-box')).toBeHidden(); // without a minimum there is no second notice
  await expect(page.locator('#rel-count')).toHaveText('37/500');
  await page.getByLabel('Versão mínima (opcional)').fill('1.0.0');
  await expect(page.locator('#prev-required-title')).toHaveText('Atualização necessária (versão 1.0.0 ou mais nova)');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('Versão publicada');
  await expect(page.locator('#release-source')).toHaveText('publicada aqui');
  await expect(page.locator('#rel-clear')).toBeVisible();

  // the installed apps get it at once: below the minimum it is required, and the message goes along
  const answer = await (await request.get('/agent/v1/version?current=0.9.0')).json();
  expect(answer).toMatchObject({ status: 'update_required', latest: '1.2.3', minimum: '1.0.0', notes: 'Corrige a pontuação e melhora o guia.' });
  expect((await (await request.get('/agent/v1/version?current=1.2.3')).json()).status).toBe('ok');
});

test('invalid data shows the reason and keeps what was typed; clearing goes back to the .env', async ({ page, request }) => {
  await logIn(page);
  await page.getByLabel('Versão mais recente').fill('abc');
  await page.getByLabel('Mensagem da versão (o que mudou)').fill('Texto que não pode sumir');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('1.2.3'); // "precisa ser como 1.2.3"
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.getByLabel('Mensagem da versão (o que mudou)')).toHaveValue('Texto que não pode sumir');
  expect((await (await request.get('/agent/v1/version')).json()).status).toBe('unknown'); // nothing was published

  await page.getByLabel('Versão mais recente').fill('1.2.3');
  await page.getByLabel('Versão mínima (opcional)').fill('2.0.0'); // above the latest
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('mínima não pode ser maior');

  await page.getByLabel('Versão mínima (opcional)').fill('1.0.0');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#release-source')).toHaveText('publicada aqui');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Voltar ao .env' }).click();
  await expect(page.locator('#release-source')).toHaveText('vem do .env');
  await expect(page.getByLabel('Mensagem da versão (o que mudou)')).toHaveValue(''); // the published message was deleted
  expect((await (await request.get('/agent/v1/version?current=0.9.0')).json()).notes).toBeNull();
});

test("the page does not load without the token, and the version page passes axe", async ({ page }) => {
  await page.goto(ADMIN_PAGE);
  await expect(page.getByRole('heading', { name: 'Versão do app' })).toBeHidden(); // only after logging in
  await logIn(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
