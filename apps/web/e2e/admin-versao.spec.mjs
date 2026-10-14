// Painel do administrador: publicar a versão do app e a mensagem (vale na hora para os apps), ver quem está desatualizado e voltar ao .env.
import { expect, test } from '@playwright/test';

const PAINEL = '/e2e-painel-secreto-0123456789/';
const TOKEN = 'e2e-admin';

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  // devolve o servidor de teste ao que o .env diz (a página inicial dos outros testes depende disso)
  await request.delete(`${PAINEL}api/release`, { headers: { 'x-admin-token': TOKEN } });
});

async function entrar(page) {
  await page.goto(PAINEL);
  await page.getByLabel('Token de administrador').fill(TOKEN);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Versão do app' })).toBeVisible();
}

test('a página mostra a versão que vem do .env e deixa publicar outra, com a mensagem; vale na hora', async ({ page, request }) => {
  await entrar(page);
  await expect(page.locator('#release-source')).toHaveText('vem do .env');
  await expect(page.getByLabel('Versão mais recente')).toHaveValue('1.2.3');
  await expect(page.locator('#rel-clear')).toBeHidden(); // nada publicado aqui ainda: não há o que limpar

  // a pré-visualização acompanha o que se digita
  await page.getByLabel('Mensagem da versão (o que mudou)').fill('Corrige a pontuação e melhora o guia.');
  await expect(page.locator('#prev-notes')).toHaveText('Corrige a pontuação e melhora o guia.');
  await expect(page.locator('#prev-title')).toHaveText('Há uma versão nova: 1.2.3');
  await expect(page.locator('#prev-required-box')).toBeHidden(); // sem mínima não há o segundo aviso
  await expect(page.locator('#rel-count')).toHaveText('37/500');
  await page.getByLabel('Versão mínima (opcional)').fill('1.0.0');
  await expect(page.locator('#prev-required-title')).toHaveText('Atualização necessária (versão 1.0.0 ou mais nova)');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('Versão publicada');
  await expect(page.locator('#release-source')).toHaveText('publicada aqui');
  await expect(page.locator('#rel-clear')).toBeVisible();

  // os apps instalados já recebem: abaixo da mínima é obrigatória, e a mensagem vai junto
  const answer = await (await request.get('/agent/v1/version?current=0.9.0')).json();
  expect(answer).toMatchObject({ status: 'update_required', latest: '1.2.3', minimum: '1.0.0', notes: 'Corrige a pontuação e melhora o guia.' });
  expect((await (await request.get('/agent/v1/version?current=1.2.3')).json()).status).toBe('ok');
});

test('dados inválidos mostram o motivo e não perdem o que foi digitado; limpar volta ao .env', async ({ page, request }) => {
  await entrar(page);
  await page.getByLabel('Versão mais recente').fill('abc');
  await page.getByLabel('Mensagem da versão (o que mudou)').fill('Texto que não pode sumir');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('1.2.3'); // "precisa ser como 1.2.3"
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.getByLabel('Mensagem da versão (o que mudou)')).toHaveValue('Texto que não pode sumir');
  expect((await (await request.get('/agent/v1/version')).json()).status).toBe('unknown'); // nada foi publicado

  await page.getByLabel('Versão mais recente').fill('1.2.3');
  await page.getByLabel('Versão mínima (opcional)').fill('2.0.0'); // acima da mais recente
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#status')).toContainText('mínima não pode ser maior');

  await page.getByLabel('Versão mínima (opcional)').fill('1.0.0');
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('#release-source')).toHaveText('publicada aqui');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Voltar ao .env' }).click();
  await expect(page.locator('#release-source')).toHaveText('vem do .env');
  await expect(page.getByLabel('Mensagem da versão (o que mudou)')).toHaveValue(''); // a mensagem publicada foi apagada
  expect((await (await request.get('/agent/v1/version?current=0.9.0')).json()).notes).toBeNull();
});

test('o painel não carrega sem o token e a página de versão passa no axe', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  await page.goto(PAINEL);
  await expect(page.getByRole('heading', { name: 'Versão do app' })).toBeHidden(); // só depois do login
  await entrar(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
