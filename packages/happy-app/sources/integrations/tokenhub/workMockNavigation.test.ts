import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
    credentials: { token: 'synthetic-screen-token', secret: 'never-send-secret' } as { token: string; secret: string } | null,
    platform: { OS: 'web' },
    replace: vi.fn(),
}));
// Only platform primitives and app auth/router boundaries are mocked. The real
// screen, React hooks, event handlers, and authenticated streaming client run.
vi.mock('react-native', () => ({
    Platform: fixture.platform, StyleSheet: { create: (styles: unknown) => styles },
    Animated: { Value: class { setValue() {} } }, Image: 'Image',
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ replace: fixture.replace }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: fixture.credentials }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy-ui.example.test' }));
// Keep the installed navigation hooks/router/native-stack view real. Only host
// header/safe-area primitives are mocked so the real stack can run in Node.
vi.mock('@react-navigation/elements', async () => {
    const R = await import('react');
    return { getHeaderTitle: () => '', Header: 'Header', HeaderBackButton: 'HeaderBackButton',
        HeaderBackContext: R.createContext(undefined), SafeAreaProviderCompat: ({ children }: any) => children,
        Screen: ({ children, header, ...props }: any) => R.createElement('Screen', props, children), useHeaderHeight: () => 0 };
});
vi.mock('@react-navigation/native', async () => ({
    ...await import('@react-navigation/core'), ...await import('@react-navigation/routers'),
    useLinkBuilder: () => ({ buildHref: () => '' }),
}));
import { BaseNavigationContainer, createNavigationContainerRef, NavigationContext } from '@react-navigation/core';
import { StackActions, type ParamListBase } from '@react-navigation/routers';
// Load the installed source so Vitest can apply host-platform mocks; the
// navigator, router, focus events and NativeStackView are not reimplemented.
import { createNativeStackNavigator } from '../../../../../node_modules/@react-navigation/native-stack/src/navigators/createNativeStackNavigator';
import TokenHubWorkMock from '@/app/(app)/tokenhub/work-mock';

const models = [{ id: 'mock-echo', name: 'Mock echo' }, { id: 'mock-slow', name: 'Mock slow stream' }, { id: 'mock-error', name: 'Mock upstream error' }];
function catalog() { return new Response(JSON.stringify({ mode: 'mock', billable: false, models }), { headers: { 'content-type': 'application/json' } }); }
function ndjson(events: unknown[]) { return events.map(event => JSON.stringify(event)).join('\n') + '\n'; }
function stream(events: unknown[]) { return new Response(ndjson(events), { headers: { 'content-type': 'application/x-ndjson' } }); }
function successful(model = 'mock-echo') { return stream([
    { type: 'delta', text: 'first chunk ' }, { type: 'delta', text: '第二片段' },
    { type: 'usage', inputTokens: 4, outputTokens: 8, model, requestId: 'screen-fixture', mock: true, billable: false }, { type: 'done' },
]); }
function openStream() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel }), { headers: { 'content-type': 'application/x-ndjson' } });
    return { response, source, cancel };
}
let renderer: ReturnType<typeof create>;
let fetcher: ReturnType<typeof vi.fn>;
function text() { return JSON.stringify(renderer.toJSON()); }
function button(label: string) {
    return renderer.root.findAllByType('Pressable').find((node: any) => node.findAllByType('Text').some((child: any) => child.props.children === label));
}
const alwaysFocused = { isFocused: () => true, addListener: () => () => {} };
function screen() { return React.createElement(NavigationContext.Provider, { value: alwaysFocused as any }, React.createElement(TokenHubWorkMock)); }
async function render() { await act(async () => { renderer = create(screen()); }); }
async function press(label: string) { await act(async () => { button(label).props.onPress(); }); }
async function select(modelName: string) { await act(async () => { renderer.root.findByProps({ accessibilityRole: 'radio', accessibilityLabel: modelName }).props.onPress(); }); }
beforeEach(() => {
    fixture.credentials = { token: 'synthetic-screen-token', secret: 'never-send-secret' }; fixture.platform.OS = 'web';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetcher = vi.fn().mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful());
    vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); vi.unstubAllGlobals(); });

it.each(['web', 'ios', 'android'])('aborts on a real retained native-stack push and reloads on pop (%s)', async platform => {
    fixture.platform.OS = platform;
    const pending = openStream();
    fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
    const navigation = createNavigationContainerRef<ParamListBase>();
    const Stack = createNativeStackNavigator();
    const mounted = vi.fn(), unmounted = vi.fn();
    function RetainedMock() {
        React.useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
        return React.createElement(TokenHubWorkMock);
    }
    const Other = () => React.createElement('Text', {}, 'Settings');
    const tree = React.createElement(BaseNavigationContainer, { ref: navigation,
        children: React.createElement(Stack.Navigator, { screenOptions: { headerShown: false } } as any,
            React.createElement(Stack.Screen, { name: 'mock', component: RetainedMock }),
            React.createElement(Stack.Screen, { name: 'settings', component: Other })) });
    await act(async () => { renderer = create(tree); });
    await press('开始模拟');
    const request = fetcher.mock.calls.find(call => String(call[0]).endsWith('/stream'))!;
    const signal = request[1].signal as AbortSignal;
    await act(async () => { pending.source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'visible before push' }]))); });
    expect(text()).toContain('visible before push');
    expect(signal.aborted).toBe(false);
    await act(async () => { navigation.dispatch(StackActions.push('settings')); });
    const hidden = renderer.root.findAllByType('Screen').find((node: any) => node.props.route.name === 'mock');
    expect(hidden!.props.focused).toBe(false);
    expect(hidden!.props.style[1].display).toBe('none');
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true); expect(pending.cancel).toHaveBeenCalledOnce();
    expect(() => pending.source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'must not arrive while hidden' }])))).toThrow();
    expect(text()).not.toContain('must not arrive while hidden');
    fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful());
    await act(async () => { navigation.goBack(); });
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/models'))).toHaveLength(2);
    expect(text()).not.toContain('visible before push'); expect(text()).toContain('尚未开始');
    await press('开始模拟'); expect(text()).toContain('已收到完成标记');
});
