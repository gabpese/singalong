// The engine (apps/engine) is TypeScript, and the app imports its compiled dist/: Node does not strip types under
// node_modules, where the packaged app keeps the engine (ROADMAP, step 4). This builds it, installing its tools the first time.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('../../engine/', import.meta.url));
const npm = (args: string) => execSync(`npm ${args}`, { cwd: engine, stdio: 'inherit' });

if (!existsSync(join(engine, 'node_modules', 'typescript'))) npm('ci --no-audit --no-fund');
npm('run build');
