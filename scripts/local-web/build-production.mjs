import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionWebEnvironment } from './production-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = productionWebEnvironment(root);
await mkdir(env.HOME, { recursive: true });
await mkdir(env.XDG_CACHE_HOME, { recursive: true });
const child = spawn(process.execPath, [path.join(root, 'node_modules/expo/bin/cli'),
    'export', '--platform', 'web', '--max-workers', '2'], {
    cwd: path.join(root, 'packages/happy-app'), env, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
