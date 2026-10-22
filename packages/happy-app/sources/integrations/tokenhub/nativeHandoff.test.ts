import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
import { nativeHandoff } from './nativeHandoff';
const state = 's'.repeat(43), input = `https://happy.example.test/tokenhub/callback?state=${state}&code=one-time-code`;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); }); afterEach(() => vi.unstubAllGlobals());
it('only accepts the exact returned state/code and fixed callback', async () => {
    const target = `happy://tokenhub/callback?state=${state}&code=one-time-code`;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ callbackUrl: target })));
    expect(await nativeHandoff(input)).toBe(target);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
});
it.each(['https://attacker.test/callback', 'happy://tokenhub/other', `happy://tokenhub/callback?state=${state}&code=other`, `happy://tokenhub/callback?state=${state}&code=one-time-code&binding=secret`])('rejects altered destination %s', async target => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ callbackUrl: target })));
    await expect(nativeHandoff(input)).rejects.toThrow();
});
it('does not reinterpret an unknown state as a native login', async () => {
    fetcher.mockResolvedValue(new Response('{}', { status: 400 })); expect(await nativeHandoff(input)).toBeNull();
});
it('rejects duplicate callback parameters without any network call', async () => {
    expect(await nativeHandoff(input + '&code=other')).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
});
