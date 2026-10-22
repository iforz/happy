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

describe('real Work mock screen interactions with isolated app boundaries', () => {
    it('shows mock-only/non-billable labels and sends selected model/prompt through existing Happy auth', async () => {
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful('mock-slow'));
        await render();
        expect(text()).toContain('MOCK ONLY · 不计费 · Web 实验');
        expect(renderer.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(3);
        await select('Mock slow stream');
        await act(async () => { renderer.root.findByProps({ accessibilityLabel: '模拟提示词' }).props.onChangeText('screen test prompt'); });
        await press('开始模拟');
        const request = fetcher.mock.calls.find((call: unknown[]) => String(call[0]).endsWith('/stream'));
        expect(JSON.parse(request![1].body)).toEqual({ model: 'mock-slow', prompt: 'screen test prompt' });
        expect(request![1].headers.Authorization).toBe('Bearer synthetic-screen-token');
        expect(text()).toContain('已收到完成标记'); expect(text()).toContain('first chunk 第二片段');
        expect(text()).toContain('模拟用量 · 不计费'); expect(text()).toContain('screen-fixture');
        expect(text()).not.toContain('never-send-secret');
    });

    it('shows a live chunk, guards repeated starts, cancels and successfully restarts', async () => {
        const pending = openStream();
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
        await render(); await select('Mock slow stream');
        await act(async () => { button('开始模拟').props.onPress(); button('开始模拟').props.onPress(); });
        await act(async () => { pending.source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'partial live output' }]))); });
        expect(text()).toContain('正在接收流式内容'); expect(text()).toContain('partial live output');
        expect(fetcher.mock.calls.filter((call: unknown[]) => String(call[0]).endsWith('/stream'))).toHaveLength(1);
        expect(button('开始模拟').props.disabled).toBe(true);
        await press('取消请求');
        expect(pending.cancel).toHaveBeenCalledOnce();
        expect(text()).toContain('已取消，保留已收到的部分内容');
        expect(text()).not.toContain('模拟用量 · 不计费'); expect(button('开始模拟').props.disabled).toBe(false);
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful('mock-slow'));
        await press('开始模拟'); expect(text()).toContain('已收到完成标记');
        expect(text()).not.toContain('partial live output');
    });

    it.each([
        ['mock_upstream_error', '模拟上游错误已返回'], ['authorization_revoked', '请先登录 Work'],
        ['gateway_timeout', '请求超过 30 秒'],
    ])('displays the right error for %s without exposing diagnostics or successful usage', async (code, message) => {
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : stream([{ type: 'error', code, message: 'private server detail' }]));
        await render(); await select('Mock upstream error'); await press('开始模拟');
        expect(text()).toContain(message); expect(text()).toContain('请求失败');
        expect(text()).not.toContain('private server detail'); expect(text()).not.toContain('模拟用量 · 不计费');
    });

    it('does not label a truncated partial response complete', async () => {
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : stream([{ type: 'delta', text: 'unfinished' }]));
        await render(); await press('开始模拟');
        expect(text()).toContain('连接提前结束'); expect(text()).toContain('unfinished'); expect(text()).not.toContain('已收到完成标记');
    });

    it('shows the disabled backend state and reloads models when retried', async () => {
        fetcher.mockResolvedValue(new Response('{"error":"disabled"}', { status: 503, headers: { 'content-type': 'application/json' } }));
        await render(); expect(text()).toContain('未启用 Mock 网关'); expect(button('开始模拟').props.disabled).toBe(true);
        fetcher.mockImplementation(async () => catalog()); await press('重新加载模型');
        expect(text()).not.toContain('未启用 Mock 网关'); expect(button('开始模拟').props.disabled).toBe(false);
    });

    it('aborts active streaming and clears output when the authenticated identity changes', async () => {
        const pending = openStream(); fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
        await render(); await press('开始模拟');
        await act(async () => { pending.source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'old identity output' }]))); });
        expect(text()).toContain('old identity output');
        await act(async () => { fixture.credentials = null; renderer.update(screen()); });
        expect(pending.cancel).toHaveBeenCalledOnce(); expect(text()).not.toContain('old identity output');
        expect(text()).toContain('请先登录 Work，然后返回此实验页');
    });

    it('cancels on unmount and never requests models when not authenticated or on native', async () => {
        const pending = openStream(); fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
        await render(); await press('开始模拟'); await act(async () => { renderer.unmount(); });
        expect(pending.cancel).toHaveBeenCalledOnce();
        fetcher.mockClear(); fixture.credentials = null; await render(); expect(fetcher).not.toHaveBeenCalled();
        await act(async () => { renderer.unmount(); }); fixture.credentials = { token: 'synthetic-screen-token', secret: 'never-send-secret' }; fixture.platform.OS = 'ios';
        await render(); expect(fetcher).not.toHaveBeenCalled(); expect(text()).toContain('目前仅支持 Web');
    });
});


it('aborts on a real native-stack push while retained, then reloads cleanly on pop', async () => {
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
