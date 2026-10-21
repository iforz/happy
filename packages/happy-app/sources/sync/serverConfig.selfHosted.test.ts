import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { saved } = vi.hoisted(() => ({ saved: new Map<string, unknown>() }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return saved.get(key) as string | undefined; }
    getBoolean(key: string) { return saved.get(key) as boolean | undefined; }
    set(key: string, value: unknown) { saved.set(key, value); }
    delete(key: string) { saved.delete(key); }
} }));
import { getServerUrl, getVoiceServerUrl, getLogServerUrl } from './serverConfig';

describe('self-hosted connection routing', () => {
    beforeEach(() => {
        saved.clear();
        vi.stubGlobal('__DEV__', false);
        vi.stubGlobal('__HAPPY_CONFIG__', undefined);
        vi.stubEnv('EXPO_PUBLIC_SELF_HOSTED', '1');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', 'https://ai.iforz.cn');
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    it('ignores saved external relay and runtime overrides', () => {
        saved.set('custom-server-url', 'https://unrelated.invalid');
        vi.stubGlobal('__HAPPY_CONFIG__', { serverUrl: 'https://another.invalid' });
        expect(getServerUrl()).toBe('https://ai.iforz.cn');
    });
    it('routes voice to the same private relay without requiring a saved toggle', () => {
        expect(getVoiceServerUrl()).toBe('https://ai.iforz.cn');
    });
    it('does not forward logs to an old saved endpoint', () => {
        saved.set('log-server-url', 'https://logs.invalid');
        expect(getLogServerUrl()).toBeNull();
    });
    it('retains normal saved relay preference for non-self-hosted builds', () => {
        vi.stubEnv('EXPO_PUBLIC_SELF_HOSTED', '0');
        saved.set('custom-server-url', 'https://unrelated.invalid');
        expect(getServerUrl()).toBe('https://unrelated.invalid');
    });
});
