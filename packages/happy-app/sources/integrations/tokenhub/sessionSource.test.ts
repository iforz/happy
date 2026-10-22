import { expect, it } from 'vitest';
import { isTokenHubSessionForUI } from './sessionSource';
const grant = { authority: 'https://accounts.example.test', authorizationToken: 'synthetic-work-grant', issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32) };
function token(payload: unknown) { return 'synthetic-header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.synthetic-signature'; }
it('recognizes the existing Happy TokenHub extras only for logout UI routing', () => {
    expect(isTokenHubSessionForUI(token({ iss: 'handy', extras: { tokenhub: grant } }))).toBe(true);
});
it.each(['old-happy-token', token({ iss: 'handy', user: 'legacy-user' }), token({ iss: 'other', extras: { tokenhub: grant } }), token({ iss: 'handy', extras: { tokenhub: {} } })])('does not label legacy or malformed token %s as a Core session', value => {
    expect(isTokenHubSessionForUI(value)).toBe(false);
});
