// Local macOS/Linux runtime for the fixed Work service. This is deliberately
// separate from the Linux-only production packager and must not be deployed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { productionWebEnvironment } from './production-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2] ?? path.join(root, '../work-local-runtime'));
if (output === root || root.startsWith(output + path.sep)) throw new Error('Invalid runtime directory');
await fs.mkdir(output, { recursive: true });
const env = { ...productionWebEnvironment(root), EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:28083' };
await fs.mkdir(env.HOME, { recursive: true });
await fs.mkdir(env.XDG_CACHE_HOME, { recursive: true });
const child = spawn(process.execPath, [path.join(root, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--max-workers', '2', '--output-dir', path.join(output, 'webapp')], { cwd: path.join(root, 'packages/happy-app'), env, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
if (code !== 0) throw new Error(`Work web build failed (${code})`);
const require = createRequire(path.join(root, 'packages/happy-app/package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
await build({ entryPoints: [path.join(root, 'packages/happy-server/sources/standalone.ts')], outfile: path.join(output, 'dist/standalone.mjs'), absWorkingDir: root,
    tsconfig: path.join(root, 'packages/happy-server/tsconfig.json'), alias: { '@': path.join(root, 'packages/happy-server/sources') }, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await fs.cp(path.join(root, 'packages/happy-server/prisma'), path.join(output, 'prisma'), { recursive: true });
// Development artifact intentionally links the already verified local dependency
// tree. Production packaging instead copies and verifies its platform closure.
const modules = path.join(output, 'node_modules');
try {
 const existing = await fs.lstat(modules);
 if (existing.isSymbolicLink()) {
  if (await fs.realpath(modules) !== await fs.realpath(path.join(root, 'packages/happy-server/node_modules'))) throw new Error('Unknown dependency link');
  await fs.unlink(modules);
 }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.mkdir(modules, { recursive: true });
for (const base of [path.join(root, 'node_modules'), path.join(root, 'packages/happy-server/node_modules')]) {
 for (const entry of await fs.readdir(base)) {
  if (entry.startsWith('.')) continue;
  const names = entry.startsWith('@') ? (await fs.readdir(path.join(base,entry))).map(name => entry+'/'+name) : [entry];
  for (const name of names) {
   const dest=path.join(modules,name);await fs.mkdir(path.dirname(dest),{recursive:true});
   try { const old=await fs.lstat(dest);if (!old.isSymbolicLink()) throw new Error('Unknown dependency entry');await fs.unlink(dest); } catch(error) { if(error.code!=='ENOENT')throw error; }
   await fs.symlink(await fs.realpath(path.join(base,name)),dest,'dir');
  }
 }
}
await fs.writeFile(path.join(output, 'BUILD-INFO.json'), JSON.stringify({ purpose: 'local-work-service-only', platform: process.platform, arch: process.arch, port: 28083, credentialsIncluded: false }, null, 2));
console.log(`Work local runtime ready: ${output}`);
