import { getServerUrl } from '@/sync/serverConfig';
import { nativeWorkFetch, nativeWorkSocketHeaders, nativeWorkSocketAllowed } from './nativeRequestContext';

const installed = Symbol.for('happy.tokenhub.native.request-context');
export function installNativeWorkRequestContext() {
    const globals = globalThis as typeof globalThis & { [installed]?: boolean };
    if (globals[installed]) return;
    globalThis.fetch = nativeWorkFetch(globalThis.fetch.bind(globalThis), getServerUrl);
    globals[installed] = true;
}
export function workSocketHeaders(endpoint: string): Record<string, string> | undefined {
    return nativeWorkSocketHeaders(endpoint, getServerUrl());
}

export function canConnectWorkSocket(endpoint: string): boolean { return nativeWorkSocketAllowed(endpoint, getServerUrl()); }
