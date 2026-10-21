import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { productionWebEnvironment } from './production-config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('production build pins branding, relay and privacy settings', () => {
    const env = productionWebEnvironment(root, { APP_ENV: 'development', EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://other.invalid',
        EXPO_PUBLIC_DEV_TOKEN: 'fixture-only', EXPO_PUBLIC_HARNESS_DEV_SECRET: 'fixture-only', OPENAI_API_KEY: 'fixture-only' });
    assert.equal(env.APP_ENV, 'production');
    assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'https://ai.iforz.cn');
    assert.equal(env.EXPO_PUBLIC_SELF_HOSTED, '1');
    assert.equal(env.EXPO_PUBLIC_DISABLE_ANALYTICS, '1');
    assert.equal(env.EXPO_NO_DOTENV, '1');
    for (const name of ['EXPO_PUBLIC_DEV_TOKEN', 'EXPO_PUBLIC_HARNESS_DEV_SECRET', 'OPENAI_API_KEY']) assert.equal(env[name], undefined);
});

test('Expo resolves production name and identifiers instead of development branding', () => {
    const result = execFileSync(process.execPath, [path.join(root, 'node_modules/expo/bin/cli'), 'config', '--type', 'public', '--json'], {
        cwd: path.join(root, 'packages/happy-app'), env: productionWebEnvironment(root), encoding: 'utf8',
    });
    const config = JSON.parse(result);
    assert.equal(config.name, 'Happy');
    assert.equal(config.ios.bundleIdentifier, 'com.ex3ndr.happy');
    assert.equal(config.android.package, 'com.ex3ndr.happy');
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
