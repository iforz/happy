const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withSelfHostedBuildConfig } = require('./selfHostedBuildConfig.cjs');
const withSelfHostedWebOnly = require('../plugins/withSelfHostedWebOnly.js');

const fixtureEnv = {
    EXPO_PUBLIC_SELF_HOSTED: '1',
    EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://work.example.invalid',
    HAPPY_IOS_BUNDLE_IDENTIFIER: 'invalid.example.work.fixture',
    HAPPY_ANDROID_PACKAGE: 'invalid.example.work.fixture',
};
const upstream = {
    name: 'Work', slug: 'happy', scheme: 'happy', runtimeVersion: '21', owner: 'bulkacorp',
    updates: { url: 'https://u.expo.dev/upstream-project', requestHeaders: { 'expo-channel-name': 'production' } },
    ios: {
        bundleIdentifier: 'com.ex3ndr.happy', associatedDomains: ['applinks:app.happy.engineering'],
        googleServicesFile: './GoogleService-Info.plist',
        entitlements: { 'aps-environment': 'production', 'com.apple.developer.associated-domains': ['applinks:app.happy.engineering'] },
        infoPlist: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }, UIBackgroundModes: ['audio', 'remote-notification'] },
    },
    android: { package: 'com.ex3ndr.happy', googleServicesFile: './google-services.json', intentFilters: [{ data: [{ host: 'app.happy.engineering' }] }] },
    plugins: ['expo-updates', ['expo-notifications', { enableBackgroundRemoteNotifications: true }], 'expo-secure-store'],
    extra: { eas: { projectId: 'upstream-project' }, router: { root: './sources/app' }, app: { elevenLabsAgentId: 'upstream-agent', buildCommitSha: 'fixture' } },
};

test('non-self-hosted configs are returned untouched, including legacy identities and services', () => {
    for (const enabled of [undefined, '0']) {
        assert.equal(withSelfHostedBuildConfig(upstream, { EXPO_PUBLIC_SELF_HOSTED: enabled }), upstream);
    }
});

test('native self-hosted config uses explicit identities, bundled code and no upstream service config', () => {
    const original = JSON.stringify(upstream);
    const config = withSelfHostedBuildConfig(upstream, fixtureEnv);
    assert.equal(JSON.stringify(upstream), original, 'must not mutate the legacy config');
    assert.equal(config.ios.bundleIdentifier, fixtureEnv.HAPPY_IOS_BUNDLE_IDENTIFIER);
    assert.equal(config.android.package, fixtureEnv.HAPPY_ANDROID_PACKAGE);
    assert.deepEqual(config.platforms, ['ios', 'android']);
    assert.deepEqual(config.updates, { enabled: false, checkAutomatically: 'NEVER', useEmbeddedUpdate: true });
    assert.equal(config.owner, undefined);
    assert.equal(config.runtimeVersion, undefined);
    assert.equal(config.extra.eas, undefined);
    assert.equal(config.extra.app.elevenLabsAgentId, undefined);
    assert.equal(config.extra.app.buildCommitSha, 'fixture');
    assert.equal(config.ios.associatedDomains, undefined);
    assert.deepEqual(config.ios.entitlements, {});
    assert.deepEqual(config.ios.infoPlist.UIBackgroundModes, ['audio']);
    assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, undefined);
    assert.deepEqual(config.android.intentFilters, []);
    assert.equal(config.ios.googleServicesFile, undefined);
    assert.equal(config.android.googleServicesFile, undefined);
    assert.deepEqual(config.plugins, ['expo-updates', 'expo-secure-store']);
    assert.equal(config.scheme, 'happy', 'preserve the authorized callback protocol');
});

test('both own application identifiers are mandatory and upstream namespaces are refused', () => {
    for (const key of ['HAPPY_IOS_BUNDLE_IDENTIFIER', 'HAPPY_ANDROID_PACKAGE']) {
        for (const value of [undefined, '', 'app', 'a..b', 'has spaces.app', 'com.slopus.happy.dev', 'com.slopus.happy.preview', 'com.ex3ndr.happy', 'Com.Ex3ndr.Happy', 'engineering.happy.tailcat.e2e']) {
            assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, [key]: value }), new RegExp(key));
        }
    }
    assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_IOS_BUNDLE_IDENTIFIER: 'invalid.example.work_app' }), /HAPPY_IOS_BUNDLE_IDENTIFIER/);
    assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_ANDROID_PACKAGE: 'invalid.example.work-app' }), /HAPPY_ANDROID_PACKAGE/);
});

test('native Work origin must be HTTPS, origin-only and without embedded authentication', () => {
    for (const url of [undefined, '', 'not a url', 'http://localhost:3005', 'http://127.0.0.1:3005', 'http://work.example.invalid', 'https://work.example.invalid/api', 'https://work.example.invalid/?a=1', 'https://work.example.invalid/#fragment', 'https://user:password@work.example.invalid']) {
        assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: url }), /EXPO_PUBLIC_HAPPY_SERVER_URL/);
    }
    assert.doesNotThrow(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://work.example.invalid:8443/' }));
});

test('explicit web-only target needs no native identity and preserves local web development', () => {
    for (const url of ['https://work.example.invalid', 'http://127.0.0.1:3005', 'http://localhost:3005', 'http://[::1]:3005']) {
        const config = withSelfHostedBuildConfig(upstream, { EXPO_PUBLIC_SELF_HOSTED: '1', HAPPY_BUILD_TARGET: 'web', EXPO_PUBLIC_HAPPY_SERVER_URL: url });
        assert.deepEqual(config.platforms, ['web']);
        assert.equal(config.ios, undefined);
        assert.equal(config.android, undefined);
        assert.ok(config.plugins.includes('./plugins/withSelfHostedWebOnly.js'));
        assert.equal(config.owner, undefined);
        assert.equal(config.extra.eas, undefined);
        assert.equal(config.updates.enabled, false);
    }
    assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_BUILD_TARGET: 'web', EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://192.168.1.2:3005' }), /HTTPS origin/);
});

test('web exemption rejects known native build context and invalid targets', () => {
    for (const key of ['EAS_BUILD_PLATFORM', 'EXPO_OS']) {
        for (const platform of ['ios', 'android']) {
            assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_BUILD_TARGET: 'web', [key]: platform }), /cannot be used/);
        }
    }
    assert.throws(() => withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_BUILD_TARGET: 'ios' }), /HAPPY_BUILD_TARGET/);
});

test('web-only native mods reject prebuild even when Expo would only warn about platforms', async () => {
    const config = withSelfHostedWebOnly({ platforms: ['web'] });
    for (const platform of ['ios', 'android']) {
        await assert.rejects(() => config.mods[platform].dangerous({ modRequest: { platform } }), /web-only/);
    }
});

test('installed Expo export resolver refuses native exports of web-only config', () => {
    const { resolvePlatformOption } = require('@expo/cli/build/src/export/resolveOptions');
    const config = withSelfHostedBuildConfig(upstream, { ...fixtureEnv, HAPPY_BUILD_TARGET: 'web' });
    const bundlers = { ios: 'metro', android: 'metro', web: 'metro' };
    assert.deepEqual(resolvePlatformOption(config, bundlers, ['web']), ['web']);
    for (const platform of ['ios', 'android']) {
        assert.throws(() => resolvePlatformOption(config, bundlers, [platform]), /missing from the supported platforms/);
    }
});

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
function expoConfig(overrides, json = true) {
    // Never load .env, user accounts or ambient service credentials for these tests.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']
        .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return spawnSync(process.execPath, [path.join(repoRoot, 'node_modules/expo/bin/cli'), 'config', '--type', 'public', ...(json ? ['--json'] : [])], {
        cwd: appRoot, encoding: 'utf8', env: {
            ...env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', CI: '1',
            HAPPY_BUILD_COMMIT_SHA: 'fixture', HAPPY_BUILD_COMMIT_TIMESTAMP: '2026-01-01T00:00:00Z', ...overrides,
        },
    });
}

test('actual Expo public config strips upstream identity for all native variants', () => {
    for (const APP_ENV of ['development', 'preview', 'production']) {
        const result = expoConfig({ ...fixtureEnv, HAPPY_BUILD_TARGET: 'native', APP_ENV });
        assert.equal(result.status, 0, result.stderr);
        const config = JSON.parse(result.stdout);
        assert.equal(config.ios.bundleIdentifier, fixtureEnv.HAPPY_IOS_BUNDLE_IDENTIFIER);
        assert.equal(config.android.package, fixtureEnv.HAPPY_ANDROID_PACKAGE);
        assert.deepEqual(config.platforms, ['ios', 'android']);
        assert.equal(config.updates.enabled, false);
        assert.equal(config.updates.useEmbeddedUpdate, true);
        assert.equal(config.updates.url, undefined);
        assert.equal(config.extra.eas, undefined);
        assert.equal(config.owner, undefined);
        assert.equal(config.ios.associatedDomains, undefined);
        assert.equal(config.android.googleServicesFile, undefined);
        assert.deepEqual(config.android.intentFilters, []);
        assert.equal(config.scheme, 'happy');
        assert.doesNotMatch(result.stdout, /bulkacorp|app\.happy\.engineering|com\.ex3ndr\.happy|com\.slopus\.happy|4558dd3d-cd5a-47cd-bad9-e591a241cc06|expo-notifications|u\.expo\.dev/);
    }
});

test('actual Expo public config fails before build for missing identities, upstream IDs and unsafe Work origins', () => {
    for (const [overrides, message] of [
        [{ HAPPY_IOS_BUNDLE_IDENTIFIER: '' }, 'HAPPY_IOS_BUNDLE_IDENTIFIER'],
        [{ HAPPY_ANDROID_PACKAGE: '' }, 'HAPPY_ANDROID_PACKAGE'],
        [{ HAPPY_IOS_BUNDLE_IDENTIFIER: 'com.ex3ndr.happy' }, 'HAPPY_IOS_BUNDLE_IDENTIFIER'],
        [{ EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:3005' }, 'EXPO_PUBLIC_HAPPY_SERVER_URL'],
        [{ HAPPY_BUILD_TARGET: 'web', EAS_BUILD_PLATFORM: 'ios' }, 'cannot be used'],
    ]) {
        const result = expoConfig({ ...fixtureEnv, ...overrides }, false);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr + result.stdout, new RegExp(message));
    }
});

test('actual Expo public legacy configs retain their previous identities and OTA linkage', () => {
    const identifiers = { development: 'com.slopus.happy.dev', preview: 'com.slopus.happy.preview', production: 'com.ex3ndr.happy' };
    for (const [APP_ENV, identifier] of Object.entries(identifiers)) {
        const result = expoConfig({ EXPO_PUBLIC_SELF_HOSTED: '0', APP_ENV });
        assert.equal(result.status, 0, result.stderr);
        const config = JSON.parse(result.stdout);
        assert.equal(config.ios.bundleIdentifier, identifier);
        assert.equal(config.android.package, identifier);
        assert.equal(config.owner, 'bulkacorp');
        assert.equal(config.extra.eas.projectId, '4558dd3d-cd5a-47cd-bad9-e591a241cc06');
        assert.equal(config.updates.url, 'https://u.expo.dev/4558dd3d-cd5a-47cd-bad9-e591a241cc06');
        assert.equal(config.android.googleServicesFile, './google-services.json');
    }
});
