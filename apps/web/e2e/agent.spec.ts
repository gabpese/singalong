// The local agent: a Session's Room sends the search and the processing to the owner's agent (here a fake agent that does
// what the installed app does: pairs, starts the Session, creates the Room and keeps claiming work over HTTP).
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { roomState, startAgentSession } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

type SearchResult = { video_id: string; title: string; channel: string; duration: number };
type AgentJob = { id: string; payload: { title: string; artist: string } };

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });

/**
 * The fake agent: it answers the Session's searches and jobs until `stop()`. Each job goes through a stage, writes the song as
 * the real agent does, and ends "ready".
 */
function runAgent(request: APIRequestContext, headers: Record<string, string>, { results }: { results: SearchResult[] }) {
  let running = true;
  const seen: { searches: string[]; jobs: AgentJob[] } = { searches: [], jobs: [] };
  const loop = (async () => {
    while (running) {
      const [search, job] = await Promise.all([
        request.post('/agent/v1/search/claim', { headers, data: { wait_ms: 300 } }),
        request.post('/agent/v1/jobs/claim', { headers, data: { wait_ms: 300 } }),
      ]);
      if (search.status() === 200) {
        const { request: asked }: { request: { id: string; q: string } } = await search.json();
        seen.searches.push(asked.q);
        await request.post(`/agent/v1/search/${asked.id}/result`, { headers, data: { results } });
      }
      if (job.status() === 200) {
        const { job: work }: { job: AgentJob } = await job.json();
        seen.jobs.push(work);
        await request.post(`/agent/v1/jobs/${work.id}/progress`, { headers, data: { stage: 'separating' } });
        await request.post('/__test/seed-song', { data: { id: work.id, title: work.payload.title, artist: work.payload.artist } });
        await request.post(`/agent/v1/jobs/${work.id}/complete`, { headers, data: { status: 'ready', stage: '', error: '' } });
      }
    }
  })();
  return { seen, async stop() { running = false; await loop; } };
}

const RESULTS = [{ video_id: 'agent000001', title: 'Legião Urbana - Tempo Perdido (Official)', channel: 'Legião Urbana', duration: 301 }];

test("the search and the song asked for on the phone are served by the Session owner's agent", async ({ page, request }) => {
  const { headers, session, room } = await startAgentSession(request, 'Dona Flor');
  const agent = runAgent(request, headers, { results: RESULTS });
  try {
    await page.goto(`/room.html?room=${room.code}`);
    await tab(page, 'Adicionar').click();
    await page.getByLabel('Seu nome').fill('Carla');
    await page.getByLabel('Artista', { exact: true }).fill('Legião Urbana');
    await page.getByLabel('Nome da música', { exact: true }).fill('Tempo Perdido');
    await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

    // the result came from the agent (the search was routed by the Room, through the X-Room header)
    await expect(page.locator('.results .result')).toHaveCount(1);
    await expect(page.locator('.results .result')).toContainText('Tempo Perdido');
    expect(agent.seen.searches).toEqual(['Legião Urbana - Tempo Perdido']);

    await page.locator('.results .result').first().click();
    await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');
    await page.getByRole('button', { name: 'Adicionar à fila' }).click();

    // the job went to the agent (and only to it), and the song gets ready in the Room
    await expect.poll(async () => (await roomState(request, room.code)).queue[0]?.song.status).toBe('ready');
    expect(agent.seen.jobs).toHaveLength(1);
    expect(agent.seen.jobs[0]).toMatchObject({ id: 'agent000001', payload: { artist: 'Legião Urbana', title: 'Tempo Perdido' } });
    await expect(page.getByText('Tempo Perdido').first()).toBeVisible();

    // the public state shows the owner's nickname, never the account or the Session's id
    const state = await roomState(request, room.code);
    expect(state.owner).toEqual({ nickname: 'Dona Flor', online: true });
    expect(JSON.stringify(state)).not.toContain(session.id);
  } finally {
    await agent.stop();
    await request.post('/__test/remove-song', { data: { id: 'agent000001' } });
  }
});

test("with the Session's owner disconnected, the search says so at once instead of waiting", async ({ page, request }) => {
  const { session, room } = await startAgentSession(request, 'Seu Zé');
  await request.post('/__test/session-offline', { data: { id: session.id } });
  expect((await roomState(request, room.code)).owner).toEqual({ nickname: 'Seu Zé', online: false });

  await page.goto(`/room.html?room=${room.code}`);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista', { exact: true }).fill('Adele');
  await page.getByLabel('Nome da música', { exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByText(/dono da sessão está desconectado/)).toBeVisible();
});

test('a Room without a Session is still served by the classic worker (the "jobs" queue)', async ({ page, request }) => {
  const res = await request.post('/api/rooms');
  const { code } = await res.json();
  expect((await roomState(request, code)).owner).toBeNull();
  await request.post('/__test/search-results', { data: RESULTS });
  await page.goto(`/room.html?room=${code}`);
  await tab(page, 'Adicionar').click();
  // an artist not in the library (otherwise the Jukebox's notice would open before the search)
  await page.getByLabel('Artista', { exact: true }).fill('Skank');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.locator('.results .result')).toHaveCount(1);
});
