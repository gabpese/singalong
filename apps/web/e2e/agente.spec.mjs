// Agente local: a sala de uma sessão manda a busca e o processamento para o agente do dono (aqui, um agente falso que faz
// o que o app instalado faz: pareia, inicia a sessão, cria a sala e fica puxando trabalho por HTTP).
import { expect, test } from '@playwright/test';
import { roomState } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const ADMIN = { 'x-admin-token': 'e2e-admin' };
const tab = (page, name) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });

/** Pareia um dispositivo, inicia a sessão com o apelido e cria uma sala nela. */
async function startSession(request, nickname) {
  const { code } = await (await request.post('/agent/v1/pair/start', { headers: ADMIN, data: {} })).json();
  const { token } = await (await request.post('/agent/v1/pair/complete', { data: { code, name: 'PC do teste' } })).json();
  const headers = { authorization: `Bearer ${token}` };
  const session = await (await request.post('/agent/v1/sessions', { headers, data: { display_name: nickname } })).json();
  const room = await (await request.post(`/agent/v1/sessions/${session.id}/rooms`, { headers, data: {} })).json();
  return { headers, session, room };
}

/**
 * O agente falso: atende as buscas e os jobs da sessão até `stop()`. Cada job passa por dois estágios, grava a música como o
 * agente de verdade e termina "ready".
 */
function runAgent(request, headers, { results }) {
  let running = true;
  const seen = { searches: [], jobs: [] };
  const loop = (async () => {
    while (running) {
      const [search, job] = await Promise.all([
        request.post('/agent/v1/search/claim', { headers, data: { wait_ms: 300 } }),
        request.post('/agent/v1/jobs/claim', { headers, data: { wait_ms: 300 } }),
      ]);
      if (search.status() === 200) {
        const { request: asked } = await search.json();
        seen.searches.push(asked.q);
        await request.post(`/agent/v1/search/${asked.id}/result`, { headers, data: { results } });
      }
      if (job.status() === 200) {
        const { job: work } = await job.json();
        seen.jobs.push(work);
        await request.post(`/agent/v1/jobs/${work.id}/progress`, { headers, data: { stage: 'separando a voz' } });
        await request.post('/__test/seed-song', { data: { id: work.id, title: work.payload.title, artist: work.payload.artist } });
        await request.post(`/agent/v1/jobs/${work.id}/complete`, { headers, data: { status: 'ready', stage: '', error: '' } });
      }
    }
  })();
  return { seen, async stop() { running = false; await loop; } };
}

const RESULTS = [{ video_id: 'agent000001', title: 'Legião Urbana - Tempo Perdido (Official)', channel: 'Legião Urbana', duration: 301 }];

test('a busca e a música pedida no celular são atendidas pelo agente do dono da sessão', async ({ page, request }) => {
  const { headers, session, room } = await startSession(request, 'Dona Flor');
  const agent = runAgent(request, headers, { results: RESULTS });
  try {
    await page.goto(`/room.html?room=${room.code}`);
    await tab(page, 'Adicionar').click();
    await page.getByLabel('Seu nome').fill('Carla');
    await page.getByLabel('Artista', { exact: true }).fill('Legião Urbana');
    await page.getByLabel('Nome da música', { exact: true }).fill('Tempo Perdido');
    await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

    // o resultado veio do agente (a busca foi roteada pela sala, pelo cabeçalho X-Room)
    await expect(page.locator('.results .result')).toHaveCount(1);
    await expect(page.locator('.results .result')).toContainText('Tempo Perdido');
    expect(agent.seen.searches).toEqual(['Legião Urbana - Tempo Perdido']);

    await page.locator('.results .result').first().click();
    await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');
    await page.getByRole('button', { name: 'Adicionar à fila' }).click();

    // o job foi para o agente (e só para ele) e a música fica pronta na sala
    await expect.poll(async () => (await roomState(request, room.code)).queue[0]?.song.status).toBe('ready');
    expect(agent.seen.jobs).toHaveLength(1);
    expect(agent.seen.jobs[0]).toMatchObject({ id: 'agent000001', payload: { artist: 'Legião Urbana', title: 'Tempo Perdido' } });
    await expect(page.getByText('Tempo Perdido').first()).toBeVisible();

    // o estado público mostra o apelido do dono, nunca a conta nem o id da sessão
    const state = await roomState(request, room.code);
    expect(state.owner).toEqual({ nickname: 'Dona Flor', online: true });
    expect(JSON.stringify(state)).not.toContain(session.id);
  } finally {
    await agent.stop();
    await request.post('/__test/remove-song', { data: { id: 'agent000001' } });
  }
});

test('com o dono da sessão desconectado, a busca avisa na hora em vez de ficar esperando', async ({ page, request }) => {
  const { session, room } = await startSession(request, 'Seu Zé');
  await request.post('/__test/session-offline', { data: { id: session.id } });
  expect((await roomState(request, room.code)).owner).toEqual({ nickname: 'Seu Zé', online: false });

  await page.goto(`/room.html?room=${room.code}`);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista', { exact: true }).fill('Adele');
  await page.getByLabel('Nome da música', { exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByText(/dono da sessão está desconectado/)).toBeVisible();
});

test('uma sala sem sessão continua sendo atendida pelo worker clássico (a fila "jobs")', async ({ page, request }) => {
  const res = await request.post('/api/rooms');
  const { code } = await res.json();
  expect((await roomState(request, code)).owner).toBeNull();
  await request.post('/__test/search-results', { data: RESULTS });
  await page.goto(`/room.html?room=${code}`);
  await tab(page, 'Adicionar').click();
  // um artista que não está na biblioteca (senão o aviso do Jukebox abriria antes da busca)
  await page.getByLabel('Artista', { exact: true }).fill('Skank');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.locator('.results .result')).toHaveCount(1);
});
