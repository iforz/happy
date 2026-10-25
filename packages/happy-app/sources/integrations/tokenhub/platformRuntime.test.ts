vi.mock('@/integrations/tokenhub/PlatformNavigation', () => ({ PlatformNavigationProvider: 'PlatformNavigationProvider', PlatformNavigationLayout: 'PlatformNavigationLayout' }));
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ path: '/', mode: undefined as string | undefined, platformFlow: false, legacyFlow: false,
    credentials: { token: 'synthetic-device-token', secret: 'synthetic-device-secret' }, getCredentials: vi.fn(), syncRestore: vi.fn(),
    reload: vi.fn(), assign: vi.fn(), replace: vi.fn(), push: vi.fn(), authLogin: vi.fn(), deviceComplete: vi.fn(), platformComplete: vi.fn(), nativeHandoff: vi.fn(),
    platform: { status: 'ready' as 'ready' | 'loading' | 'error' | 'disabled', session: null as null | { authority: string; subject: string; sessionId: string } }, authProps: vi.fn(),
}));
vi.mock('react-native-quick-base64', () => ({}));
vi.mock('@/theme.css', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', AppState: { currentState: 'active' }, LogBox: { ignoreLogs: () => {} } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: f.replace, push: f.push }), usePathname: () => f.path, useGlobalSearchParams: () => ({ mode: f.mode }), Slot: 'PlatformSlot' }));
vi.mock('./PlatformSessionProvider', () => ({ PlatformSessionProvider: ({ children }: { children: React.ReactNode }) => children, usePlatformSession: () => ({ ...f.platform, complete: f.platformComplete }) }));
vi.mock('./platformSession', () => ({ hasPlatformLogin: () => f.platformFlow }));
vi.mock('./login', () => ({ hasMatchingWebLogin: () => f.legacyFlow, completeTokenHubLogin: f.deviceComplete,
    saveTokenHubLogin: async (result: { token: string; secret: string }, login: (token: string, secret: string) => Promise<void>) => login(result.token, result.secret) }));
vi.mock('./nativeHandoff', () => ({ nativeHandoff: f.nativeHandoff }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: f.getCredentials, setCredentials: () => { throw new Error('Unexpected credential write during boot'); }, removeCredentials: () => { throw new Error('Unexpected credential deletion during boot'); } } }));
vi.mock('@/auth/AuthContext', () => ({ AuthProvider: (props: any) => { f.authProps(props.initialCredentials); return props.children; }, useAuth: () => ({ isAuthenticated: true, credentials: f.credentials, login: f.authLogin }) }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { ready: Promise.resolve() } }));
vi.mock('@/sync/sync', () => ({ syncRestore: f.syncRestore }));
vi.mock('expo-splash-screen', () => ({ setOptions: () => {}, preventAutoHideAsync: () => {}, hideAsync: async () => {} }));
vi.mock('expo-font', () => ({ loadAsync: async () => {} }));
vi.mock('@expo/vector-icons', () => ({ FontAwesome: { font: {} } }));
vi.mock('expo-notifications', () => ({ setNotificationHandler: () => {}, addNotificationResponseReceivedListener: () => ({ remove: () => {} }), getLastNotificationResponseAsync: async () => null }));
vi.mock('@react-navigation/native', () => ({ DarkTheme: { colors: {} }, DefaultTheme: { colors: {} }, ThemeProvider: 'ThemeProvider' }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardProvider: 'KeyboardProvider' }));
vi.mock('react-native-safe-area-context', () => ({ initialWindowMetrics: {}, SafeAreaProvider: 'SafeAreaProvider', useSafeAreaInsets: () => ({ left: 0, right: 0 }) }));
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'GestureHandlerRootView' }));
vi.mock('@/components/SidebarNavigator', () => ({ SidebarNavigator: 'DeviceSidebar' }));
vi.mock('@/modal', () => ({ ModalProvider: 'ModalProvider' }));
vi.mock('posthog-react-native', () => ({ PostHogProvider: 'PostHogProvider' }));
vi.mock('@/track/tracking', () => ({ tracking: null }));
vi.mock('@/track/useTrackScreens', () => ({ useTrackScreens: () => {} }));
vi.mock('@/realtime/RealtimeProvider', () => ({ RealtimeProvider: 'RealtimeProvider' }));
vi.mock('@/components/web/FaviconPermissionIndicator', () => ({ FaviconPermissionIndicator: () => null }));
vi.mock('@/components/CommandPalette/CommandPaletteProvider', () => ({ CommandPaletteProvider: 'CommandPaletteProvider' }));
vi.mock('@/components/StatusBarProvider', () => ({ StatusBarProvider: () => null }));
vi.mock('@/utils/consoleLogging', () => ({ initConsoleLogging: () => {}, setConsoleOutputEnabled: () => {} }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => false }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { dark: false, colors: { groupped: { background: 'white' } } } }) }));
// Font-loading is unrelated to runtime ownership; skip its asset require callback.
vi.mock('@/utils/lock', () => ({ AsyncLock: class { async inLock() {} } }));
vi.mock('@/utils/notificationRouting', () => ({ getSessionRouteFromNotificationResponse: () => null }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: () => {} }));
vi.mock('@/realtime/voiceExperiment', () => ({ applyVoiceUpsellOverride: () => {} }));
vi.mock('@/hooks/useTauriZoom', () => ({ useTauriZoom: () => {} }));
vi.mock('@/hooks/useTauriDrag', () => ({ useTauriDrag: () => {} }));
vi.mock('@/hooks/useBrowserNavigationShortcuts', () => ({ BrowserNavigationShortcuts: () => null }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://work.example.test' }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
import RootLayout from '@/app/_layout';
import TokenHubCallback from '@/app/(app)/tokenhub/callback';

let renderer: ReturnType<typeof create> | undefined;
const browser = () => window as unknown as { location: { href: string; pathname: string; reload: typeof f.reload; assign: typeof f.assign }; history: { replaceState: ReturnType<typeof vi.fn> } };
async function renderRoot() { await act(async () => { renderer = create(React.createElement(RootLayout)); }); }
async function rerenderRoot() { await act(async () => { renderer.update(React.createElement(RootLayout)); }); }
function navigate(path: string) { f.path = path; browser().location.href = 'https://work.example.test/work' + path; browser().location.pathname = '/work' + path; }
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__DEV__', false); vi.useFakeTimers();
    f.path = '/'; f.mode = undefined; f.platformFlow = false; f.legacyFlow = false; f.platform.status = 'ready'; f.platform.session = null;
    [f.getCredentials, f.syncRestore, f.reload, f.assign, f.replace, f.push, f.authLogin, f.deviceComplete, f.platformComplete, f.nativeHandoff, f.authProps].forEach(fn => fn.mockReset());
    f.getCredentials.mockResolvedValue(f.credentials); f.syncRestore.mockResolvedValue(undefined); f.authLogin.mockResolvedValue(undefined);
    f.deviceComplete.mockResolvedValue(f.credentials); f.platformComplete.mockResolvedValue(undefined); f.nativeHandoff.mockResolvedValue(null);
    vi.stubGlobal('window', { location: { href: 'https://work.example.test/work/', pathname: '/work/', reload: f.reload, assign: f.assign }, history: { replaceState: vi.fn() } });
});
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('actual root runtime ownership', () => {
    it('boots ordinary Home with Slot and no legacy credential read or sync restore', async () => {
        await renderRoot(); expect(renderer!.root.findAllByType('PlatformSlot')).toHaveLength(1); expect(renderer!.root.findAllByType('DeviceSidebar')).toHaveLength(0);
        expect(f.getCredentials).not.toHaveBeenCalled(); expect(f.syncRestore).not.toHaveBeenCalled(); expect(f.authProps).toHaveBeenCalledWith(null);
    });
    it('keeps settings navigation in the platform runtime without loading a device identity', async () => {
        f.platform.session = { authority: 'https://accounts.example.test', subject: '42', sessionId: 'session-one' };
        await renderRoot();
        for (const path of ['/settings', '/settings/appearance', '/settings/language', '/settings/account', '/']) {
            navigate(path); await rerenderRoot();
            expect(f.reload).not.toHaveBeenCalled(); expect(f.getCredentials).not.toHaveBeenCalled(); expect(f.syncRestore).not.toHaveBeenCalled();
            expect(renderer!.root.findAllByType('DeviceSidebar')).toHaveLength(0);
            expect(renderer!.root.findAllByType('PlatformNavigationLayout')).toHaveLength(1);
            expect(renderer!.root.findByType('PlatformNavigationProvider').props.scope).toBe(JSON.stringify(['https://accounts.example.test', '42', 'session-one']));
        }
    });
    it('boots an explicit device route with the preserved legacy identity', async () => {
        navigate('/device-agents'); await renderRoot(); expect(renderer!.root.findAllByType('DeviceSidebar')).toHaveLength(1);
        expect(f.getCredentials).toHaveBeenCalledOnce(); expect(f.syncRestore).toHaveBeenCalledWith(f.credentials);
    });
    it.each([['/', '/device-agents'], ['/device-agents', '/']] as const)('uses a full-document boundary from %s to %s', async (from, to) => {
        navigate(from); await renderRoot(); const reads = f.getCredentials.mock.calls.length;
        navigate(to); await rerenderRoot(); expect(f.reload).toHaveBeenCalledOnce(); expect(renderer!.toJSON()).toBeNull(); expect(f.getCredentials.mock.calls.length).toBe(reads);
    });
    it('keeps ordinary and conflicting-marker callbacks in the platform runtime', async () => {
        navigate('/tokenhub/callback'); f.platformFlow = true; f.legacyFlow = true; await renderRoot();
        expect(renderer!.root.findAllByType('PlatformSlot')).toHaveLength(1); expect(f.getCredentials).not.toHaveBeenCalled();
    });
    it('boots a matching legacy callback as device and does not flip after its one-use marker is consumed', async () => {
        navigate('/tokenhub/callback'); f.legacyFlow = true; await renderRoot();
        expect(renderer!.root.findAllByType('DeviceSidebar')).toHaveLength(1); expect(f.syncRestore).toHaveBeenCalledWith(f.credentials);
        // Completing a legacy callback strips its query/state before the async exchange finishes.
        f.legacyFlow = false; await rerenderRoot();
        expect(f.reload).not.toHaveBeenCalled(); expect(renderer!.root.findAllByType('DeviceSidebar')).toHaveLength(1);
        navigate('/device-agents'); await rerenderRoot(); expect(f.reload).not.toHaveBeenCalled();
        navigate('/'); await rerenderRoot(); expect(f.reload).toHaveBeenCalledOnce();
    });
});

describe('actual callback destination', () => {
    it('routes successful legacy completion to the explicit device workspace rather than platform Home', async () => {
        f.legacyFlow = true; navigate('/tokenhub/callback');
        await act(async () => { renderer = create(React.createElement(TokenHubCallback)); });
        expect(f.authLogin).toHaveBeenCalledWith(f.credentials.token, f.credentials.secret);
        expect(f.replace).toHaveBeenCalledWith('/device-agents'); expect(f.platformComplete).not.toHaveBeenCalled();
    });
    it('does not switch a pending legacy callback into platform completion after its state is consumed', async () => {
        let finish!: (value: typeof f.credentials) => void;
        f.deviceComplete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        f.legacyFlow = true; navigate('/tokenhub/callback');
        await act(async () => { renderer = create(React.createElement(TokenHubCallback)); });
        f.legacyFlow = false;
        await act(async () => { renderer.update(React.createElement(TokenHubCallback)); });
        await act(async () => { finish(f.credentials); });
        expect(f.deviceComplete).toHaveBeenCalledOnce(); expect(f.platformComplete).not.toHaveBeenCalled();
        expect(f.authLogin).toHaveBeenCalledOnce(); expect(f.replace).toHaveBeenCalledWith('/device-agents');
    });
    it('gives matching platform flow precedence and never invokes legacy identity completion', async () => {
        f.legacyFlow = true; f.platformFlow = true; navigate('/tokenhub/callback');
        await act(async () => { renderer = create(React.createElement(TokenHubCallback)); });
        expect(f.platformComplete).toHaveBeenCalled(); expect(f.deviceComplete).not.toHaveBeenCalled(); expect(f.authLogin).not.toHaveBeenCalled(); expect(f.replace).toHaveBeenCalledWith('/');
    });
});
