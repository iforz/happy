import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWebConfig } from './config.mjs';

if (process.argv.includes('--help')) {
    console.log('pnpm web:local: run the real Expo web client and PGlite relay on loopback only.\nOptional ports: HAPPY_LOCAL_WEB_PORT (8081), HAPPY_LOCAL_SERVER_PORT (3005).\nDevelopment fixture credentials only. Do not expose this service or use personal data.');
    process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { env, dataDir, webPort, serverPort } = localWebConfig(root);
const children = new Set();
let stopping = false;
function stop(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    process.exitCode = code;
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
function run(entry, args, cwd) {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: 'inherit' });
    children.add(child);
    child.on('exit', () => children.delete(child));
    child.on('error', error => { console.error(error.message); stop(1); });
    return child;
}
async function freePort(port) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise(resolve => probe.close(resolve));
}
try {
    await freePort(webPort);
    await freePort(serverPort);
    await mkdir(env.HOME, { recursive: true });
    await mkdir(env.XDG_CACHE_HOME, { recursive: true });
    const tsx = path.join(root, 'node_modules/tsx/dist/loader.mjs');
    const serverDir = path.join(root, 'packages/happy-server');
    const migrate = run('--import', [tsx, 'sources/standalone.ts', 'migrate'], serverDir);
    const exitCode = await new Promise(resolve => migrate.once('exit', resolve));
    if (exitCode !== 0 || stopping) throw new Error(`Relay migration failed (${exitCode})`);
    const relay = run('--import', [tsx, 'sources/standalone.ts', 'serve'], serverDir);
    relay.on('exit', code => { if (!stopping) stop(code || 1); });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
        try {
            const response = await fetch(`${env.PUBLIC_URL}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { ready = true; break; }
        } catch { /* Wait for relay startup, never a remote endpoint. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Local relay did not become healthy within 60 seconds');
    const web = run(path.join(root, 'node_modules/expo/bin/cli'),
        ['start', '--web', '--localhost', '--port', String(webPort), '--max-workers', '2'],
        path.join(root, 'packages/happy-app'));
    web.on('exit', code => { if (!stopping) stop(code || 1); });
    console.log(`\nLocal web: http://localhost:${webPort}\nLocal relay: ${env.PUBLIC_URL}\nDisposable data: ${dataDir}\nNo model runtime or provider account is connected. Ctrl+C stops both services.\n`);
} catch (error) {
    console.error(error.message);
    stop(1);
}
