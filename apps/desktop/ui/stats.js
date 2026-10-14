// Estatísticas do dono: os números formatados e o desenho do cartão. Nenhum texto de fora entra como HTML (só textContent).

/** Bytes em "1,2 GB", "340 MB"... (base 1000, como o Windows mostra no disco). */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace('.', ',')} ${units[unit]}`;
}

/** Segundos em "1 min 30 s", "45 s" ou "—" (sem dado). */
export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.round(Number(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Nota média ("80" ou "—"). */
export const formatScore = (score) => (score === null || score === undefined ? '—' : String(Math.round(Number(score))));

/** "Artista — Título", só o título ou "(sem nome)". */
export function songName(song) {
  const title = song?.title?.trim();
  const artist = song?.artist?.trim();
  if (title && artist) return `${artist} — ${title}`;
  return title || artist || '(sem nome)';
}

/** O movimento por dia dos últimos `days` dias (no máximo 14 barras), do mais antigo ao mais novo, com os dias sem música como 0. */
export function activityBars(byDay, days, today = new Date()) {
  const counts = new Map((byDay ?? []).map((entry) => [entry.day, entry.songs]));
  const bars = [];
  const shown = Math.min(days, 14);
  for (let i = shown - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const day = date.toISOString().slice(0, 10);
    bars.push({ day, songs: counts.get(day) ?? 0 });
  }
  return bars;
}

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

function stat(label, value) {
  const box = make('div', 'stat');
  box.append(make('strong', '', String(value)), make('span', 'muted', label));
  return box;
}

function list(title, rows, empty = 'Ainda não há dados.') {
  const section = make('div', 'stats-list');
  section.append(make('h3', '', title));
  if (!rows.length) {
    section.append(make('p', 'muted', empty));
    return section;
  }
  const ol = make('ol');
  for (const [name, detail] of rows) {
    const li = make('li');
    li.append(make('span', 'stats-name', name), make('span', 'muted', detail));
    ol.append(li);
  }
  section.append(ol);
  return section;
}

/** Desenha as estatísticas (`{ server, library }` do controlador) dentro de `container`. */
export function renderStats(container, data) {
  const { server, library } = data;
  const totals = server.totals;
  container.replaceChildren();

  const grid = make('div', 'stats-grid');
  grid.append(
    stat('músicas cantadas', totals.songs),
    stat('cantores', totals.singers),
    stat('sessões', totals.sessions),
    stat('aplausos', totals.cheers),
    stat('nota média', formatScore(totals.avg_score)),
    stat('puladas', totals.skipped),
  );
  container.append(grid);

  const bars = activityBars(server.by_day, server.days);
  const max = Math.max(1, ...bars.map((bar) => bar.songs));
  const chartBox = make('div', 'stats-chart-box');
  chartBox.append(make('div', 'muted', `Músicas por dia (últimos ${bars.length} dias)`));
  const chart = make('div', 'stats-chart');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Músicas por dia nos últimos ${bars.length} dias`);
  for (const bar of bars) {
    const column = make('div', 'bar');
    column.style.height = `${Math.max(4, Math.round((bar.songs / max) * 100))}%`;
    column.title = `${bar.day.slice(8, 10)}/${bar.day.slice(5, 7)}: ${bar.songs}`;
    chart.append(column);
  }
  const ends = make('div', 'stats-chart-ends');
  ends.append(make('span', '', `${bars[0].day.slice(8, 10)}/${bars[0].day.slice(5, 7)}`), make('span', '', 'hoje'));
  chartBox.append(chart, ends);
  container.append(chartBox);

  const columns = make('div', 'stats-columns');
  columns.append(
    list('Mais tocadas', server.top_songs.slice(0, 5).map((song) => [songName(song), `${song.plays}×${song.avg_score === null ? '' : ` · nota ${formatScore(song.avg_score)}`}`])),
    list('Quem mais cantou', server.top_singers.slice(0, 5).map((singer) => [singer.name, `${singer.songs} música${singer.songs === 1 ? '' : 's'}${singer.avg_score === null ? '' : ` · nota ${formatScore(singer.avg_score)}`}`])),
    list('Mais aplaudidas', server.most_cheered.slice(0, 3).map((song) => [songName(song), `${song.cheers} aplausos`]), 'Ninguém aplaudiu ainda.'),
  );

  const local = make('div', 'stats-list');
  local.append(make('h3', '', 'Biblioteca neste computador'));
  local.append(
    make('p', '', `${library.songs} música${library.songs === 1 ? '' : 's'} · ${formatBytes(library.bytes)} · preparo médio ${formatSeconds(library.avg_prepare_s)}`),
  );
  if (library.biggest.length) {
    const ol = make('ol');
    for (const song of library.biggest) {
      const li = make('li');
      li.append(make('span', 'stats-name', songName(song)), make('span', 'muted', formatBytes(song.bytes)));
      ol.append(li);
    }
    local.append(make('p', 'muted', 'As que mais ocupam espaço:'), ol);
  }
  columns.append(local);
  container.append(columns);
}
