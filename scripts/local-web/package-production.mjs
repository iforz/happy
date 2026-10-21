#!/usr/bin/env node
// Build on a Linux x64 build machine; the destination needs only Node.js 24.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: PNPM_BIN=/absolute/path/to/pnpm node scripts/local-web/package-production.mjs [output-directory]

Defaults to ../happy-web-production, outside this checkout. The destination must
not exist. Requires a completed pnpm 10.11.0 install, generated Prisma client,
built happy-wire, and a production Expo web export in packages/happy-app/dist.
WEB_DIST may name another production export. This command packages offline;
Set HAPPY_PACKAGE_ALLOW_DOWNLOAD=1 to fetch missing locked tarballs.
It does not deploy, start a server, create credentials, or modify service files.
Build for Linux x64 with Node.js 24. Never supply a harness/debug-auth export.`);
    process.exit(0);
}

function fail(message) {
    throw new Error(message);
}

function need(file, description = file) {
    if (!fs.existsSync(file)) fail(`Missing ${description}`);
    return file;
}

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function verifyLinks(directory, artifact) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isSymbolicLink()) {
            if (!inside(artifact, fs.realpathSync(file))) fail(`Artifact symlink escapes its directory: ${file}`);
        } else if (item.isDirectory()) {
            verifyLinks(file, artifact);
        }
    }
}

try {
    if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) fail('Use --help for supported arguments.');
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
        fail('Package on Linux x64 using Node.js 24 for the intended Debian x64 runtime.');
    }
    const target = path.resolve(root, args[0] ?? '../happy-web-production');
    const canonicalParent = fs.realpathSync(path.dirname(target));
    const artifact = path.join(canonicalParent, path.basename(target));
    if (inside(fs.realpathSync(root), artifact)) fail('Output must be outside this checkout.');
    if (fs.lstatSync(artifact, { throwIfNoEntry: false })) fail(`Output already exists; choose a fresh directory: ${artifact}`);
    const web = fs.realpathSync(need(path.resolve(root, process.env.WEB_DIST ?? 'packages/happy-app/dist')));
    need(path.join(web, 'index.html'), 'production Expo export index.html');
    for (const key of ['EXPO_PUBLIC_DEV_TOKEN', 'EXPO_PUBLIC_DEV_SECRET', 'EXPO_PUBLIC_HARNESS_DEV_TOKEN', 'EXPO_PUBLIC_HARNESS_DEV_SECRET']) {
        if (process.env[key]) fail(`Refusing packaging while ${key} is set. Use a clean production build environment.`);
    }
    const pnpm = process.env.PNPM_BIN;
    if (!pnpm || !path.isAbsolute(pnpm)) fail('Set PNPM_BIN to the absolute pnpm 10.11.0 executable or its .cjs/.mjs file.');
    need(pnpm, 'PNPM_BIN executable');
    const pnpmCommand = /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm;
    const prefix = pnpmCommand === process.execPath ? [pnpm] : [];
    const version = execFileSync(pnpmCommand, [...prefix, '--version'], { cwd: root, encoding: 'utf8' }).trim();
    if (version !== '10.11.0') fail(`Expected pnpm 10.11.0, got ${version}.`);

    const sourceRequire = createRequire(path.join(root, 'packages/happy-server/package.json'));
    const appRequire = createRequire(path.join(root, 'packages/happy-app/package.json'));
    const prismaPackage = sourceRequire.resolve('@prisma/client/package.json');
    const prismaRequire = createRequire(prismaPackage);
    const generated = path.dirname(prismaRequire.resolve('.prisma/client/package.json'));
    need(path.join(generated, 'schema.prisma'), 'generated Prisma client (run happy-server generate first)');
    need(path.join(generated, 'libquery_engine-debian-openssl-3.0.x.so.node'), 'Prisma Debian/OpenSSL 3 query engine');
    need(path.join(root, 'packages/happy-wire/dist/index.mjs'), 'happy-wire ESM build');
    need(path.join(root, 'packages/happy-wire/dist/index.cjs'), 'happy-wire CommonJS build');
    const { build } = await import(pathToFileURL(appRequire.resolve('esbuild')).href);

    // Legacy deploy disables frozen-lockfile and may resolve ranges anew.
    // Stage just these two workspace importers, retaining every source lock
    // snapshot and integrity hash, then perform a genuinely frozen install.
    const yaml = sourceRequire('yaml');
    const lock = yaml.parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
    const selectedImporter = lock.importers['packages/happy-server-self-host'];
    const wireImporter = lock.importers['packages/happy-wire'];
    if (!selectedImporter || !wireImporter) fail('Required importers are missing from pnpm-lock.yaml.');
    const selfHost = path.join(root, 'packages/happy-server-self-host');
    const manifest = JSON.parse(fs.readFileSync(path.join(selfHost, 'package.json'), 'utf8'));
    const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    manifest.private = true;
    manifest.pnpm = rootManifest.pnpm;
    selectedImporter.dependencies['@slopus/happy-wire'].version = 'link:packages/happy-wire';
    // The server directly imports this transitive dependency. Promote only
    // Octokit's existing locked version; do not query registry metadata.
    const octokitRef = selectedImporter.dependencies.octokit.version;
    const webhooksRef = lock.snapshots[`octokit@${octokitRef}`]?.dependencies?.['@octokit/webhooks'];
    if (!webhooksRef) fail('The locked Octokit webhooks dependency was not found.');
    const webhooksVersion = webhooksRef.split('(')[0];
    manifest.dependencies['@octokit/webhooks'] = webhooksVersion;
    selectedImporter.dependencies['@octokit/webhooks'] = { specifier: webhooksVersion, version: webhooksRef };
    lock.importers = { '.': selectedImporter, 'packages/happy-wire': wireImporter };
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(artifact, 'pnpm-lock.yaml'), yaml.stringify(lock));
    fs.writeFileSync(path.join(artifact, 'pnpm-workspace.yaml'), 'packages:\n  - packages/happy-wire\n');
    for (const name of ['bin', 'index.cjs', 'README.md']) {
        fs.cpSync(need(path.join(selfHost, name)), path.join(artifact, name), { recursive: true });
    }
    const wireSource = path.join(root, 'packages/happy-wire');
    const wireTarget = path.join(artifact, 'packages/happy-wire');
    fs.mkdirSync(wireTarget, { recursive: true });
    for (const name of ['dist', 'package.json', 'README.md']) {
        fs.cpSync(need(path.join(wireSource, name)), path.join(wireTarget, name), { recursive: true });
    }
    console.log('Installing the exact frozen production closure into the isolated artifact.');
    execFileSync(pnpmCommand, [...prefix,
        'install', '--prod', '--frozen-lockfile', '--ignore-scripts',
        ...(process.env.HAPPY_PACKAGE_ALLOW_DOWNLOAD === '1' ? ['--prefer-offline'] : ['--offline']),
        '--config.node-linker=isolated', '--config.shamefully-hoist=false',
        '--config.package-import-method=copy', '--config.strict-peer-dependencies=false',
        ...(process.env.PNPM_STORE_DIR ? ['--store-dir', process.env.PNPM_STORE_DIR] : []),
    ], { cwd: artifact, stdio: 'inherit' });
    const artifactRequire = createRequire(path.join(artifact, 'package.json'));
    const deployedClient = artifactRequire.resolve('@prisma/client/package.json');
    const generatedTarget = path.resolve(path.dirname(deployedClient), '../../.prisma/client');
    if (!inside(artifact, generatedTarget)) fail('Prisma client target escapes the artifact.');
    fs.cpSync(generated, generatedTarget, { recursive: true });
    fs.cpSync(path.join(root, 'packages/happy-server/prisma'), path.join(artifact, 'prisma'), { recursive: true });
    fs.cpSync(web, path.join(artifact, 'webapp'), { recursive: true });
    fs.mkdirSync(path.join(artifact, 'dist'), { recursive: true });

    await build({
        entryPoints: [path.join(root, 'packages/happy-server/sources/standalone.ts')],
        outfile: path.join(artifact, 'dist/standalone.mjs'),
        absWorkingDir: root,
        tsconfig: path.join(root, 'packages/happy-server/tsconfig.json'),
        alias: { '@': path.join(root, 'packages/happy-server/sources') },
        bundle: true,
        packages: 'external',
        platform: 'node',
        target: 'node24',
        format: 'esm',
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
        logLevel: 'info',
    });

    // Preserve the repository's existing Bytes-column compatibility patch.
    // Installation uses copies, not shared store hardlinks, so edits stay here.
    const adapterDirectory = path.dirname(artifactRequire.resolve('pglite-prisma-adapter'));
    for (const name of ['index.mjs', 'index.cjs']) {
        const file = need(path.join(adapterDirectory, name));
        const source = fs.readFileSync(file, 'utf8');
        const patched = source.replace(/Uint8Array\.from\(\s*\{\s*length:\s*hexString\.length\s*\/\s*2\s*\}/g, 'Array.from({ length: hexString.length / 2 }');
        if (patched !== source) fs.writeFileSync(file, patched);
    }

    const pkgPath = path.join(artifact, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.private = true;
    pkg.type = 'module';
    pkg.scripts = { start: 'node dist/standalone.mjs serve', migrate: 'node dist/standalone.mjs migrate' };
    delete pkg.publishConfig;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const pgliteDist = path.dirname(artifactRequire.resolve('@electric-sql/pglite'));
    need(path.join(pgliteDist, 'pglite.wasm'));
    need(path.join(pgliteDist, 'pglite.data'));
    need(path.join(path.dirname(artifactRequire.resolve('@slopus/happy-wire')), 'index.mjs'));
    need(path.join(generatedTarget, 'libquery_engine-debian-openssl-3.0.x.so.node'));
    // Loading sharp checks the selected native optional package and libvips.
    artifactRequire('sharp');
    for (const name of fs.readdirSync(artifact)) {
        if (name.startsWith('.env') || ['.context', 'data', '.happy', 'auth.json', 'master-secret'].includes(name)) {
            fail(`Unexpected private/runtime data in artifact: ${name}`);
        }
    }
    verifyLinks(artifact, artifact);
    console.log(`Production artifact ready: ${artifact}\nNo server was started. Run migrations and serve from this directory with separately supplied production configuration.\nKeep the complete node_modules tree when archiving; do not dereference symlinks or include development state.`);
} catch (error) {
    console.error(`Packaging failed: ${error.message}\nAny partially created output is retained for inspection; this script never deletes an existing directory.`);
    process.exitCode = 1;
}
