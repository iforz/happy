import { describe, it, expect } from 'vitest';
import { pinnedSelfHostedServer } from './selfHostedServer';

describe('pinned self-hosted relay', () => {
    it('keeps normal upstream behavior unchanged when not opted in', () => {
        expect(pinnedSelfHostedServer(undefined, undefined)).toBeNull();
        expect(pinnedSelfHostedServer('0', 'invalid')).toBeNull();
    });
    it('accepts secure deployment and plain loopback origins', () => {
        expect(pinnedSelfHostedServer('1', 'https://ai.iforz.cn/')).toBe('https://ai.iforz.cn');
        expect(pinnedSelfHostedServer('1', 'http://127.0.0.1:3005')).toBe('http://127.0.0.1:3005');
    });
    it('keeps the explicitly supported Work prefix for HTTP and realtime requests', () => {
        expect(pinnedSelfHostedServer('1', 'https://token.example.test/work/')).toBe('https://token.example.test/work');
    });
    it('fails closed for missing, insecure, credential-bearing, or path-prefixed config', () => {
        for (const value of [undefined, '', 'invalid', 'http://example.com', 'https://user:pass@example.com',
            'https://example.com/api', 'https://example.com/?token=test', 'https://example.com/#test', 'ftp://example.com']) {
            expect(() => pinnedSelfHostedServer('1', value)).toThrow();
        }
    });
});
