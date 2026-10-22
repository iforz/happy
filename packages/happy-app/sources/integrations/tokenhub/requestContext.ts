/** Web keeps the browser's own User-Agent and transport behavior unchanged. */
export function installNativeWorkRequestContext() {}
export function workSocketHeaders(_endpoint: string): Record<string, string> | undefined { return undefined; }

export function canConnectWorkSocket(_endpoint: string): boolean { return true; }
