import { requiresRuntimeRestart, RUNTIME_RESTART_MESSAGE } from './runtimeRestart.native';

// A transparent application identifier, not a browser impersonation or authentication credential.
export const NATIVE_WORK_USER_AGENT = 'TokenHubWorkNative/1';

export function isSelectedWorkOrigin(input: string | URL | Request, selectedServer: string): boolean {
    try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        const selected = new URL(selectedServer);
        if (url.protocol === 'wss:') url.protocol = 'https:';
        if (url.protocol === 'ws:') url.protocol = 'http:';
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
            && !selected.username && !selected.password && url.origin === selected.origin;
    } catch { return false; }
}

export function nativeWorkFetch(transport: typeof fetch, selectedServer: () => string): typeof fetch {
    return (input, init) => {
        if (!isSelectedWorkOrigin(input, selectedServer())) return transport(input, init);
        if (requiresRuntimeRestart()) return Promise.reject(new Error(RUNTIME_RESTART_MESSAGE));
        const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
        headers.set('User-Agent', NATIVE_WORK_USER_AGENT);
        return transport(input, { ...init, headers });
    };
}

export function nativeWorkSocketHeaders(endpoint: string, selectedServer: string): Record<string, string> | undefined {
    if (!isSelectedWorkOrigin(endpoint, selectedServer)) return undefined;
    if (requiresRuntimeRestart()) throw new Error(RUNTIME_RESTART_MESSAGE);
    return { 'User-Agent': NATIVE_WORK_USER_AGENT };
}

export function nativeWorkSocketAllowed(endpoint: string, selectedServer: string): boolean {
    return !isSelectedWorkOrigin(endpoint, selectedServer) || !requiresRuntimeRestart();
}
