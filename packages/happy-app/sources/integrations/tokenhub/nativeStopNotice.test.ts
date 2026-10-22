import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ platform: { OS: 'ios' }, credentials: null as { token: string; secret: string } | null,
    blocked: false, removeOk: true, reload: vi.fn(), fetch: vi.fn(), disconnect: vi.fn() }));
vi.mock('react-native', () => ({ Platform: fixture.platform, StyleSheet: { create: (styles: unknown) => styles },
    Animated: { Value: class { setValue() {} } }, Image: 'Image', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('@react-navigation/elements', async () => {
    const R = await import('react');
    return { getHeaderTitle: () => '', Header: 'Header', HeaderBackButton: 'HeaderBackButton',
        HeaderBackContext: R.createContext(undefined), SafeAreaProviderCompat: ({ children }: any) => children,
        Screen: ({ children, ...props }: any) => R.createElement('Screen', props, children), useHeaderHeight: () => 0 };
});
vi.mock('@react-navigation/native', async () => ({ ...await import('@react-navigation/core'), ...await import('@react-navigation/routers'), useLinkBuilder: () => ({ buildHref: () => '' }) }));
vi.mock('@/integrations/tokenhub/NativeSessionStopNotice', async () => await import('./NativeSessionStopNotice.native'));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => fixture.credentials,
    setCredentials: async () => true, removeCredentials: async () => { if (!fixture.removeOk) return false; fixture.credentials = null; return true; } } }));
vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: fixture.disconnect } }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn(), loadRegisteredPushToken: () => null }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('expo', () => ({ reloadAppAsync: fixture.reload }));
vi.mock('@/integrations/tokenhub/runtimeRestart', () => ({ requiresRuntimeRestart: () => fixture.blocked,
    markRuntimeRestartRequired: () => { fixture.blocked = true; }, RUNTIME_RESTART_MESSAGE: 'Runtime stopped' }));
vi.mock('@/integrations/tokenhub/sessionLifecycle', () => ({ preserveTokenHubIdentity: vi.fn(), clearTokenHubLocalSession: vi.fn(),
    invalidateTokenHubLogin: vi.fn(), watchTokenHubSession: () => () => {} }));
vi.mock('@/integrations/tokenhub/logoutNotice', () => ({ saveSessionNotice: vi.fn(), clearSessionNotice: vi.fn() }));
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { BaseNavigationContainer, createNavigationContainerRef } from '@react-navigation/core';
import { StackActions, type ParamListBase } from '@react-navigation/routers';
import { createNativeStackNavigator } from '../../../../../node_modules/@react-navigation/native-stack/src/navigators/createNativeStackNavigator';
const token = 'synthetic.' + Buffer.from(JSON.stringify({ iss: 'handy', extras: { tokenhub: { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: 'work-grant' } } })).toString('base64url') + '.signature';
let renderer: ReturnType<typeof create>, auth: ReturnType<typeof useAuth>;
let navigation: ReturnType<typeof createNavigationContainerRef<ParamListBase>>;
const mounted = vi.fn(), unmounted = vi.fn();
function Home() { return React.createElement('Text', {}, 'Retained home'); }
function Account() {
    auth = useAuth(); React.useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
    return React.createElement('Text', {}, auth.isAuthenticated ? 'Account: signed in' : 'Account: not authenticated');
}
async function mountAccount() {
    navigation = createNavigationContainerRef<ParamListBase>(); const Stack = createNativeStackNavigator();
    const nav = React.createElement(BaseNavigationContainer, { ref: navigation, children:
        React.createElement(Stack.Navigator, { screenOptions: { headerShown: false } } as any,
            React.createElement(Stack.Screen, { name: 'home', component: Home }), React.createElement(Stack.Screen, { name: 'account', component: Account })) });
    await act(async () => { renderer = create(React.createElement(AuthProvider, { initialCredentials: fixture.credentials, children: nav })); });
    await act(async () => { navigation.dispatch(StackActions.push('account')); });
}
const modal = () => renderer.root.findByType('Modal');
// Inspect rendered Text values rather than serializing React owner internals.
const visibleWords = () => modal().findAllByType('Text').map((text: any) => text.props.children).join(' ');
beforeEach(() => { fixture.blocked = false; fixture.removeOk = true; fixture.platform.OS = 'ios'; fixture.credentials = { token, secret: 'retained-identity' };
    fixture.reload.mockReset(); fixture.reload.mockResolvedValue(undefined); fixture.fetch.mockReset(); fixture.fetch.mockResolvedValue(new Response('{}', { status: 503 }));
    fixture.disconnect.mockClear(); mounted.mockClear(); unmounted.mockClear(); vi.stubGlobal('fetch', fixture.fetch); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.unstubAllGlobals(); });
it.each([['ios', 'throw'], ['android', 'throw'], ['ios', 'no-op'], ['android', 'no-op']])('covers a retained account page after reload %s/%s and cannot be dismissed to old authenticated operations', async (platform, reload) => {
    fixture.platform.OS = platform; if (reload === 'throw') fixture.reload.mockRejectedValue(new Error('Reload disabled'));
    await mountAccount(); expect(navigation.getCurrentRoute()?.name).toBe('account');
    await act(async () => { await auth.logout(); });
    expect(navigation.getCurrentRoute()?.name).toBe('account'); expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
    expect(modal().props).toMatchObject({ visible: true, transparent: false, presentationStyle: 'fullScreen', allowSwipeDismissal: false });
    expect(visibleWords()).toContain('本机授权已清除'); expect(visibleWords()).toContain('完全关闭并重新打开'); expect(visibleWords()).toContain('远端撤销未确认');
    expect(auth.isAuthenticated).toBe(false); expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).not.toContain('Account: signed in');
    await act(async () => { modal().props.onRequestClose(); }); expect(modal().props.visible).toBe(true);
    expect(modal().findAllByType('Pressable')).toHaveLength(0); expect(fixture.fetch).toHaveBeenCalledOnce();
});
it('shows honest pending cleanup over the account page and coalesces repeated retry without another remote revoke', async () => {
    fixture.removeOk = false; await mountAccount();
    await act(async () => { await expect(auth.logout()).rejects.toThrow('remove local credentials'); });
    expect(visibleWords()).toContain('本机凭据尚未清除'); expect(visibleWords()).not.toContain('本机授权已清除'); expect(visibleWords()).toContain('远端撤销未确认');
    expect(fixture.reload).not.toHaveBeenCalled(); expect(auth.isAuthenticated).toBe(false);
    const retry = modal().findByType('Pressable').props.onPress;
    fixture.removeOk = true;
    await act(async () => { retry(); retry(); });
    expect(fixture.fetch).toHaveBeenCalledOnce(); expect(fixture.reload).toHaveBeenCalledOnce(); expect(fixture.credentials).toBeNull();
    expect(visibleWords()).toContain('本机授权已清除'); expect(visibleWords()).toContain('远端撤销未确认'); expect(modal().findAllByType('Pressable')).toHaveLength(0);
});
