import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { productionWebEnvironment, productionOrigin } from './production-config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('production build pins branding, relay and privacy settings', () => {
    const env = productionWebEnvironment(root, { APP_ENV: 'development', EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://other.invalid',
        EXPO_PUBLIC_DEV_TOKEN: 'fixture-only', EXPO_PUBLIC_HARNESS_DEV_SECRET: 'fixture-only', OPENAI_API_KEY: 'fixture-only' });
    assert.equal(env.APP_ENV, 'production');
    assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'https://work.mzyai.com');
    assert.equal(env.EXPO_PUBLIC_SELF_HOSTED, '1');
    assert.equal(env.HAPPY_BUILD_TARGET, 'web');
    assert.equal(env.EXPO_PUBLIC_DISABLE_ANALYTICS, '1');
    assert.equal(env.EXPO_NO_DOTENV, '1');
    for (const name of ['EXPO_PUBLIC_DEV_TOKEN', 'EXPO_PUBLIC_HARNESS_DEV_SECRET', 'OPENAI_API_KEY']) assert.equal(env[name], undefined);
});

test('Expo resolves Work web branding without upstream native or OTA identity', () => {
    const result = execFileSync(process.execPath, [path.join(root, 'node_modules/expo/bin/cli'), 'config', '--type', 'public', '--json'], {
        cwd: path.join(root, 'packages/happy-app'), env: productionWebEnvironment(root), encoding: 'utf8',
    });
    const config = JSON.parse(result);
    assert.equal(config.name, 'Work');
    assert.deepEqual(config.platforms, ['web']);
    assert.equal(config.ios?.bundleIdentifier, undefined);
    assert.equal(config.android?.package, undefined);
    assert.equal(config.ios?.associatedDomains, undefined);
    assert.equal(config.android?.googleServicesFile, undefined);
    assert.equal(config.owner, undefined);
    assert.equal(config.extra.eas, undefined);
    assert.equal(config.updates.enabled, false);
    assert.equal(config.updates.url, undefined);
});

test('all explicitly registered app stack screens have actual route files', () => {
    const app = path.join(root, 'packages/happy-app/sources/app/(app)');
    const layout = fs.readFileSync(path.join(app, '_layout.tsx'), 'utf8');
    const routes = [...layout.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map(match => match[1]);
    assert.ok(routes.length > 20, 'guard against a silently ineffective route scan');
    for (const route of routes) {
        assert.ok(['.tsx', '.ts', '.jsx', '.js', '/_layout.tsx'].some(ext => fs.existsSync(path.join(app, route + ext))),
            `Stack.Screen ${route} has no route file`);
    }
    assert.ok(!routes.includes('dev/masked-progress'));
});

 test('explicit production origin accepts only exact public HTTPS origins', () => {
 assert.equal(productionWebEnvironment(root,{HAPPY_PRODUCTION_ORIGIN:'https://work.iforz.cn'}).EXPO_PUBLIC_HAPPY_SERVER_URL,'https://work.iforz.cn');
 for(const raw of ['http://work.iforz.cn','https://work.iforz.cn/','https://work.iforz.cn/path','https://user@work.iforz.cn','https://work.iforz.cn?x=1','https://work.iforz.cn#x','https://127.0.0.1','https://localhost','https://work.localhost',' https://work.iforz.cn']) assert.throws(()=>productionOrigin(raw));
 });
