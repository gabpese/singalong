// `tsc` compiles the server's code into dist/. The admin page (src/admin/page: HTML, CSS and the browser's own script) is
// not server code: it is copied as it is, so the browser gets exactly the files in the repository.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/admin/page', import.meta.url));
const to = fileURLToPath(new URL('../dist/admin/page', import.meta.url));

rmSync(to, { recursive: true, force: true }); // no leftover from an older build (tsc has already written the server's code next to it)
cpSync(from, to, { recursive: true });
