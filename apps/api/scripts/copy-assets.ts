// `tsc` compiles the server's code and the admin page's script into dist/. The page's HTML and CSS are not code: they are
// copied as they are.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/admin/page/', import.meta.url));
const to = fileURLToPath(new URL('../dist/admin/page/', import.meta.url));

mkdirSync(to, { recursive: true });
for (const file of ['index.html', 'admin.css']) copyFileSync(from + file, to + file);
