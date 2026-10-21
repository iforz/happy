import { describe, expect, it, vi } from 'vitest';
import { createTokenHubClient, TokenHubError, type TokenHubClientOptions, type TokenHubFetch } from './client';

function fixture(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(body: unknown = { code: 0, data: { balance: 12.5 } }, status = 200) {
    const fetch = vi.fn<TokenHubFetch>().mockImplementation(async () => fixture(body, status));
    const tokenProvider = vi.fn<TokenHubClientOptions['tokenProvider']>()
        .mockImplementation(async scope => scope === 'panel' ? 'fixture-panel' : 'fixture-gateway');
    const client = createTokenHubClient({ baseUrl: 'https://gateway.example.test/deployment/', fetch, tokenProvider });
    return { client, fetch, tokenProvider };
}

describe('optional TokenHub read-only client', () => {
    it('does nothing until explicitly called and uses a separate panel token', async () => {
        const { client, fetch, tokenProvider } = setup();
        expect(fetch).not.toHaveBeenCalled();
        expect(tokenProvider).not.toHaveBeenCalled();
        await expect(client.getBalance()).resolves.toEqual({ balance: 12.5 });
        expect(tokenProvider).toHaveBeenCalledWith('panel');
        expect(fetch).toHaveBeenCalledWith('https://gateway.example.test/deployment/api/v1/user/profile', {
            method: 'GET', headers: { Authorization: 'Bearer fixture-panel', Accept: 'application/json' },
            credentials: 'omit', redirect: 'error', cache: 'no-store', signal: undefined,
        });
    });

    it('uses only a gateway token to list models and strips unrelated response fields', async () => {
        const { client, fetch, tokenProvider } = setup({ object: 'list', data: [{ id: 'model-a', owned_by: 'example' }] });
        await expect(client.listModels()).resolves.toEqual([{ id: 'model-a' }]);
        expect(tokenProvider).toHaveBeenCalledWith('gateway');
        expect(fetch).toHaveBeenCalledWith('https://gateway.example.test/deployment/v1/models', expect.objectContaining({
            headers: { Authorization: 'Bearer fixture-gateway', Accept: 'application/json' },
        }));
    });

    it('returns server summary without converting it into local charges', async () => {
        const data = { total_requests: 3, total_cost: 1.25, custom_metric: { version: 2 } };
        const { client, fetch } = setup({ code: 0, data });
        await expect(client.getUsageSummary()).resolves.toEqual(data);
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/usage/stats'), expect.objectContaining({ method: 'GET' }));
    });

    it('preserves negative balances and fetches credentials anew', async () => {
        const { client, tokenProvider } = setup({ code: 0, data: { balance: -0.5 } });
        await expect(client.getBalance()).resolves.toEqual({ balance: -0.5 });
        await client.getBalance();
        expect(tokenProvider).toHaveBeenCalledTimes(2);
    });

    it.each(['http://gateway.example.test', 'https://user:password@gateway.example.test',
        'https://gateway.example.test/?token=fixture', 'https://gateway.example.test/#fragment', 'not a url'])
    ('rejects unsafe base URL %s before requesting credentials', baseUrl => {
        const tokenProvider = vi.fn();
        expect(() => createTokenHubClient({ baseUrl, tokenProvider })).toThrow(TokenHubError);
        expect(tokenProvider).not.toHaveBeenCalled();
    });

    it.each([null, '', ' ', 'bad\ntoken', 'two words'])('rejects unusable credentials without fetching', async token => {
        const fetch = vi.fn();
        const client = createTokenHubClient({ baseUrl: 'https://gateway.example.test', fetch, tokenProvider: async () => token });
        await expect(client.getBalance()).rejects.toMatchObject({ kind: 'authentication' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([[401, 'authentication'], [403, 'forbidden'], [429, 'rate_limit'], [500, 'http']] as const)
    ('classifies HTTP %s without retry or exposing body', async (status, kind) => {
        const { client, fetch } = setup({ message: 'sensitive upstream body' }, status);
        await expect(client.getBalance()).rejects.toMatchObject({ kind, status, message: `TokenHub request failed (${kind})` });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([{ balance: 1 }, { code: 1, data: { balance: 1 } }, { code: 0, data: [] },
        { code: 0, data: { balance: '1' } }, { code: 0, data: { balance: null } }])
    ('rejects malformed or unsuccessful panel response', async body => {
        await expect(setup(body).client.getBalance()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it.each([{ data: null }, { data: [{ id: '' }] }, { data: [{ id: 4 }] }, { data: [null] }])
    ('rejects invalid model catalog', async body => {
        await expect(setup(body).client.listModels()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('rejects non-JSON without exposing response content', async () => {
        const { client, fetch } = setup();
        fetch.mockResolvedValue(new Response('<html>private detail</html>'));
        await expect(client.getBalance()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('sanitizes transport and credential-provider exceptions', async () => {
        const { client, fetch, tokenProvider } = setup();
        fetch.mockRejectedValue(new Error('fixture-gateway private detail'));
        await expect(client.getBalance()).rejects.toMatchObject({ kind: 'network', message: 'TokenHub request failed (network)' });
        tokenProvider.mockRejectedValue(new Error('private credential detail'));
        await expect(client.getBalance()).rejects.toMatchObject({ kind: 'authentication', message: 'TokenHub request failed (authentication)' });
    });

    it('does not resolve credentials or fetch when already aborted', async () => {
        const { client, fetch, tokenProvider } = setup();
        const controller = new AbortController(); controller.abort();
        await expect(client.getBalance(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
        expect(tokenProvider).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });

    it('honors cancellation while credentials are resolving', async () => {
        const { client, fetch, tokenProvider } = setup();
        const controller = new AbortController();
        tokenProvider.mockImplementation(async () => { controller.abort(); return 'fixture-panel'; });
        await expect(client.getBalance(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('forwards cancellation and returns a typed abort error', async () => {
        const { client, fetch } = setup();
        const controller = new AbortController();
        fetch.mockImplementation(async (_url, init) => {
            expect(init?.signal).toBe(controller.signal);
            controller.abort(); throw new Error('aborted');
        });
        await expect(client.listModels(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    });
});
