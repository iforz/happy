/** The normal web workspace never initializes a legacy encrypted-device session. */
export function isPlatformRoute(pathname: string, mode?: unknown, flows?: { platform?: boolean; legacy?: boolean }): boolean {
    if (pathname === '/tokenhub/callback') return Boolean(flows?.platform || !flows?.legacy);
    return pathname === '/' || (pathname === '/new' && mode !== 'device');
}
