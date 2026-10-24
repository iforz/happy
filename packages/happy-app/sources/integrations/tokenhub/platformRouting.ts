/** The normal web workspace never initializes a legacy encrypted-device session. */
export function isPlatformRoute(pathname: string, mode?: unknown): boolean {
    return pathname === '/' || (pathname === '/new' && mode !== 'device') || pathname === '/tokenhub/callback';
}
