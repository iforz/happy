import test from 'node:test';
import assert from 'node:assert/strict';
import { localWebConfig } from './config.mjs';

test('loopback-only defaults, isolated data and analytics off', () => {
    const config = localWebConfig('/tmp/happy-fixture', { PATH: '/usr/bin' });
    assert.equal(config.env.HOST, '127.0.0.1');
    assert.equal(config.env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'http://127.0.0.1:3005');
    assert.equal(config.env.EXPO_PUBLIC_DISABLE_ANALYTICS, '1');
    assert.equal(config.env.HAPPY_BUILD_TARGET, 'web');
    assert.equal(config.env.EXPO_NO_TELEMETRY, '1');
    assert.equal(config.env.HOME, '/tmp/happy-fixture/.happy-web-local/home');
});
test('does not inherit remote services, credentials, or user home', () => {
    const { env } = localWebConfig('/tmp/happy-fixture', {
        HOME: '/private-home', OPENAI_API_KEY: 'test-only', GITHUB_PRIVATE_KEY: 'test-only',
        DATABASE_URL: 'remote-test', S3_HOST: 'remote-test', REDIS_URL: 'remote-test',
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://remote.invalid', HOST: '0.0.0.0',
    });
    for (const key of ['OPENAI_API_KEY', 'GITHUB_PRIVATE_KEY', 'DATABASE_URL', 'S3_HOST', 'REDIS_URL']) {
        assert.equal(env[key], undefined);
    }
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'http://127.0.0.1:3005');
});
test('allows distinct unprivileged ports and rejects malformed or conflicting ports', () => {
    assert.equal(localWebConfig('/tmp/happy-fixture', { HAPPY_LOCAL_WEB_PORT: '18081' }).webPort, 18081);
    for (const value of ['abc', '0', '80', '65536', '8081x', '-1']) {
        assert.throws(() => localWebConfig('/tmp/happy-fixture', { HAPPY_LOCAL_WEB_PORT: value }));
    }
    assert.throws(() => localWebConfig('/tmp/happy-fixture', { HAPPY_LOCAL_WEB_PORT: '3005' }));
});
