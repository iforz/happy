import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEVICE_SESSION_ROUTE } from './newSessionRoute';
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
it('wraps the actual /new route in the account-aware entry', () => {
    const route = source('../../app/(app)/new/index.tsx');
    expect(route).toContain('return <NewSessionEntry><NewSessionScreen /></NewSessionEntry>');
    expect(route).toContain('export default React.memo(NewSessionRoute)');
});
it('device-agent navigation remains explicit rather than falling into account chat', () => {
    expect(DEVICE_SESSION_ROUTE).toEqual({ pathname: '/new', params: { mode: 'device' } });
    for (const component of ['MainView', 'EmptyMainScreen', 'EmptySessionsTablet']) {
        const text = source('../../components/' + component + '.tsx');
        expect(text).toContain('router.navigate(DEVICE_SESSION_ROUTE)');
        expect(text).not.toContain("router.navigate('/new')");
    }
});
it('removes the obsolete footer render and every translated copy', () => {
    expect(source('../../components/SettingsView.tsx')).not.toContain('settings.aboutFooter');
    expect(source('../../text/_default.ts')).not.toContain('aboutFooter:');
    const directory = fileURLToPath(new URL('../../text/translations', import.meta.url));
    for (const name of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
        expect(source('../../text/translations/' + name)).not.toContain('aboutFooter:');
    }
});
