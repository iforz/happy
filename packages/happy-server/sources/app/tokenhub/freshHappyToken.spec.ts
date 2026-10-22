import { afterEach, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('fresh verification verifies the signed Happy payload rather than trusting the existing token cache', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HANDY_MASTER_SECRET', 'isolated-tokenhub-test-seed-not-a-real-credential');
    await auth.init();
    const extras = { tokenhub: { subject: '42', authorizationToken: 'test-work-token' } };
    const token = await auth.createToken('test-happy-account', extras);
    extras.tokenhub.subject = '99';
    expect((await auth.verifyToken(token))?.extras.tokenhub.subject).toBe('99');
    expect(await auth.verifyToken(token, { cache: false })).toEqual({ userId: 'test-happy-account', extras: { tokenhub: { subject: '42', authorizationToken: 'test-work-token' } } });
    expect(await auth.verifyToken(token + 'tampered', { cache: false })).toBeNull();
});
