/** Optional, read-only TokenHub transport. Never uses Happy's identity or encryption keys. */
export type TokenHubCredentialScope = 'panel' | 'gateway';
export type TokenHubFetch = (url: string, init: RequestInit) => Promise<Response>;
export type TokenHubErrorKind = 'configuration' | 'authentication' | 'forbidden' | 'rate_limit' | 'http' | 'network' | 'aborted' | 'invalid_response';

export class TokenHubError extends Error {
    constructor(public readonly kind: TokenHubErrorKind, public readonly status?: number) {
        // Do not include credentials, response bodies, or URLs in errors.
        super(`TokenHub request failed (${kind})`);
        this.name = 'TokenHubError';
    }
}

export interface TokenHubClientOptions {
    /** Origin or deployment prefix, without /api/v1 or /v1. HTTPS only. */
    baseUrl: string;
    /** Resolve separately scoped, existing credentials; no persistence or key creation. */
    tokenProvider: (scope: TokenHubCredentialScope) => Promise<string | null>;
    fetch?: TokenHubFetch;
}

export interface TokenHubBalance { balance: number }
export interface TokenHubModel { id: string }
/** Server-owned summary. Deliberately not interpreted as Happy session usage or a currency. */
export type TokenHubUsageSummary = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function panelData(value: unknown): Record<string, unknown> {
    if (!isRecord(value) || value.code !== 0 || !isRecord(value.data)) {
        throw new TokenHubError('invalid_response');
    }
    return value.data;
}

export function createTokenHubClient(options: TokenHubClientOptions) {
    let base: URL;
    try {
        base = new URL(options.baseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
            throw new Error();
        }
    } catch {
        throw new TokenHubError('configuration');
    }
    const baseUrl = base.toString().replace(/\/+$/, '');
    const transport = options.fetch ?? globalThis.fetch;
    const tokenProvider = options.tokenProvider;
    if (typeof transport !== 'function' || typeof tokenProvider !== 'function') {
        throw new TokenHubError('configuration');
    }

    async function get(path: string, scope: TokenHubCredentialScope, signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) throw new TokenHubError('aborted');
        let token: string | null;
        try { token = await tokenProvider(scope); }
        catch { throw new TokenHubError(signal?.aborted ? 'aborted' : 'authentication'); }
        if (signal?.aborted) throw new TokenHubError('aborted');
        if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) {
            throw new TokenHubError('authentication');
        }
        let response: Response;
        try {
            response = await transport(`${baseUrl}${path}`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                signal,
            });
        } catch {
            throw new TokenHubError(signal?.aborted ? 'aborted' : 'network');
        }
        if (signal?.aborted) throw new TokenHubError('aborted');
        if (!response.ok) {
            const kind = response.status === 401 ? 'authentication'
                : response.status === 403 ? 'forbidden'
                : response.status === 429 ? 'rate_limit' : 'http';
            throw new TokenHubError(kind, response.status);
        }
        try { return await response.json(); }
        catch { throw new TokenHubError(signal?.aborted ? 'aborted' : 'invalid_response'); }
    }

    return {
        async getBalance(signal?: AbortSignal): Promise<TokenHubBalance> {
            const data = panelData(await get('/api/v1/user/profile', 'panel', signal));
            if (typeof data.balance !== 'number' || !Number.isFinite(data.balance)) {
                throw new TokenHubError('invalid_response');
            }
            // Negative balances are valid observations; never clamp or charge locally.
            return { balance: data.balance };
        },
        async getUsageSummary(signal?: AbortSignal): Promise<TokenHubUsageSummary> {
            return panelData(await get('/api/v1/usage/stats', 'panel', signal));
        },
        async listModels(signal?: AbortSignal): Promise<TokenHubModel[]> {
            const value = await get('/v1/models', 'gateway', signal);
            if (!isRecord(value) || !Array.isArray(value.data)) throw new TokenHubError('invalid_response');
            return value.data.map((model: unknown) => {
                if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) {
                    throw new TokenHubError('invalid_response');
                }
                return { id: model.id };
            });
        },
    };
}
