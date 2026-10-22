import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ blocked: false, io: vi.fn(), disconnect: vi.fn() }));
vi.mock('./runtimeRestart.native', () => ({ requiresRuntimeRestart: () => fixture.blocked, RUNTIME_RESTART_MESSAGE: 'runtime blocked' }));
vi.mock('@/integrations/tokenhub/requestContext', async () => await import('./requestContext.native'));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('socket.io-client', () => ({ io: fixture.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'fixture' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => ({ token: 'old-token' }) } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ localSettings: {} }) } }));
import { apiSocket } from '@/sync/apiSocket';
afterEach(() => { apiSocket.disconnect(); fixture.blocked = false; fixture.io.mockReset(); fixture.disconnect.mockReset(); });
it('the actual ApiSocket connect entry cannot create or recreate a Work socket in the invalidated native runtime', () => {
    fixture.io.mockReturnValue({ on: vi.fn(), onAny: vi.fn(), disconnect: fixture.disconnect });
    apiSocket.initialize({ endpoint: 'https://happy.example.test', token: 'old-token' }, {} as never);
    expect(fixture.io).toHaveBeenCalledOnce(); expect(fixture.io.mock.calls[0][1].extraHeaders).toEqual({ 'User-Agent': 'TokenHubWorkNative/1' });
    apiSocket.disconnect(); fixture.blocked = true;
    apiSocket.connect(); apiSocket.updateToken('unused-new-token');
    apiSocket.initialize({ endpoint: 'https://happy.example.test', token: 'old-token' }, {} as never);
    expect(fixture.io).toHaveBeenCalledOnce(); expect(fixture.disconnect).toHaveBeenCalledOnce();
    // The guard does not silently alter sockets targeting an unrelated origin.
    apiSocket.initialize({ endpoint: 'https://third-party.example.test', token: 'third-party-token' }, {} as never);
    expect(fixture.io).toHaveBeenCalledTimes(2); expect(fixture.io.mock.calls[1][1].extraHeaders).toBeUndefined();
});
