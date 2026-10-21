import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWebConfig } from './config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifact = process.argv[2] ? path.resolve(process.argv[2]) : null;
const { env } = localWebConfig(root, { PATH: process.env.PATH, HAPPY_LOCAL_SERVER_PORT: '13005' });
const state = path.join(root, '.happy-web-local', artifact ? 'artifact-verification' : 'source-verification');
Object.assign(env, { DATA_DIR: state, PGLITE_DIR: path.join(state, 'pglite'),
    HAPPY_STATIC_DIR: artifact ? path.join(artifact, 'webapp') : path.join(root, 'packages/happy-app/dist'),
    HAPPY_INJECT_HTML_CONFIG: JSON.stringify({ serverUrl: 'http://127.0.0.1:13005', disableAnalytics: true }),
});
await mkdir(state, { recursive: true });
const cwd = artifact || path.join(root, 'packages/happy-server');
const prefix = artifact ? [path.join(artifact, 'dist/standalone.mjs')]
    : ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), 'sources/standalone.ts'];
const children = new Set();
let peakRssKB = 0;
function start(action) {
    const child = spawn(process.execPath, [...prefix, action], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('exit', () => children.delete(child));
    child.done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => resolve({ code, output }));
    });
    return child;
}
const sample = setInterval(async () => {
    for (const child of children) {
        try {
            const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
            const rss = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0);
            peakRssKB = Math.max(peakRssKB, rss);
        } catch { /* Exited between samples. */ }
    }
}, 100);
let server;
try {
    const migration = await start('migrate').done;
    await writeFile(path.join(state, 'migration.log'), migration.output);
    if (migration.code !== 0) throw new Error(`Migration failed (${migration.code}): ${migration.output}`);
    const migrationPeakRssKB = peakRssKB;
    peakRssKB = 0;
    server = start('serve');
    const origin = 'http://127.0.0.1:13005';
    let healthy = false;
    for (let i = 0; i < 120; i++) {
        try {
            if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; }
        } catch { /* Startup in progress. */ }
        if (server.exitCode !== null) throw new Error(`Server exited: ${(await server.done).output}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!healthy) throw new Error('Relay health timeout');
    const checks = [];
    for (const [route, expected] of [['/health', 200], ['/', 200], ['/server', 200], ['/v1/account/profile', 401], ['/v1/sessions', 401]]) {
        const response = await fetch(origin + route);
        const body = await response.text();
        checks.push({ route, status: response.status, expected, bodyLength: body.length });
        if (response.status !== expected) throw new Error(`Unexpected ${route} status ${response.status}`);
        if (route === '/') {
            if (!body.includes('disableAnalytics')) throw new Error('Runtime config not injected');
            const asset = body.match(/src="([^\"]+\.js)"/)?.[1];
            if (!asset) throw new Error('No exported web entrypoint in HTML');
            const js = await fetch(new URL(asset, origin));
            checks.push({ route: asset, status: js.status, expected: 200 });
            if (!js.ok) throw new Error('Exported JS missing');
        }
    }
    const websocket = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:13005/v1/updates/?EIO=4&transport=websocket`);
        const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket handshake timed out')); }, 5000);
        ws.onmessage = event => { clearTimeout(timer); ws.close(); resolve(String(event.data).startsWith('0{')); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket handshake failed')); };
    });
    if (!websocket) throw new Error('Invalid Engine.IO handshake');
    await new Promise(resolve => setTimeout(resolve, 15000));
    const status = await readFile(`/proc/${server.pid}/status`, 'utf8');
    const settledRssKB = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0);
    const report = { artifact, checks, websocketHandshake: websocket, migrationPeakRssKB, serverPeakRssKB: peakRssKB, settledRssKB,
        caveat: 'Idle smoke test only; no authenticated sessions, model execution or load tested.' };
    await writeFile(path.join(state, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    clearInterval(sample);
    if (server && server.exitCode === null) server.kill('SIGTERM');
    if (server) { const result = await server.done; await writeFile(path.join(state, 'server.log'), result.output); }
}
