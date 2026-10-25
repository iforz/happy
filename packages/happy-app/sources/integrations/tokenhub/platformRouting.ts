/** The normal web workspace never initializes a legacy encrypted-device session. */
export function isPlatformRoute(pathname: string, mode?: unknown, flows?: { platform?: boolean; legacy?: boolean }): boolean {
    if (pathname === '/tokenhub/callback') return Boolean(flows?.platform || !flows?.legacy);
    if (['/settings', '/settings/appearance', '/settings/language', '/settings/account'].includes(pathname.replace(/\/$/, ''))) return true;
    return pathname === '/' || (pathname === '/new' && mode !== 'device');
}
