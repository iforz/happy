import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
    credentials: { token: 'synthetic-screen-token', secret: 'never-send-secret' } as { token: string; secret: string } | null,
    platform: { OS: 'web' },
    focused: true,
    replace: vi.fn(),
}));
// Only platform primitives and app auth/router boundaries are mocked. The real
// screen, React hooks, event handlers, and authenticated streaming client run.
vi.mock('react-native', () => ({
    Platform: fixture.platform, StyleSheet: { create: (styles: unknown) => styles },
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
}));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ replace: fixture.replace }) }));
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    return { useFocusEffect: (callback: () => (() => void)) => React.useEffect(() => fixture.focused ? callback() : undefined, [callback, fixture.focused]) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: fixture.credentials }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy-ui.example.test' }));
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
async function render() { await act(async () => { renderer = create(React.createElement(TokenHubWorkMock)); }); }
async function press(label: string) { await act(async () => { button(label).props.onPress(); }); }
async function select(modelName: string) { await act(async () => { renderer.root.findByProps({ accessibilityRole: 'radio', accessibilityLabel: modelName }).props.onPress(); }); }
beforeEach(() => {
    fixture.credentials = { token: 'synthetic-screen-token', secret: 'never-send-secret' }; fixture.platform.OS = 'web'; fixture.focused = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetcher = vi.fn().mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful());
    vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); vi.unstubAllGlobals(); });

describe.each(['web', 'ios', 'android'])('real Work mock screen interactions on %s with isolated app boundaries', platform => {
    beforeEach(() => { fixture.platform.OS = platform; });
    it('shows mock-only/non-billable labels and sends selected model/prompt through existing Happy auth', async () => {
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful('mock-slow'));
        await render();
        expect(text()).toContain('MOCK ONLY · 不计费 · 跨端实验');
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
        await act(async () => { fixture.credentials = null; renderer.update(React.createElement(TokenHubWorkMock)); });
        expect(pending.cancel).toHaveBeenCalledOnce(); expect(text()).not.toContain('old identity output');
        expect(text()).toContain('请先登录 Work，然后返回此实验页');
    });

    it('cancels on unmount and never requests models when not authenticated', async () => {
        const pending = openStream(); fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
        await render(); await press('开始模拟'); await act(async () => { renderer.unmount(); });
        expect(pending.cancel).toHaveBeenCalledOnce();
        fetcher.mockClear(); fixture.credentials = null; await render(); expect(fetcher).not.toHaveBeenCalled();
    });
    it('aborts on navigation blur even while the screen remains mounted, and safely restarts on focus', async () => {
        const pending = openStream(); fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : pending.response);
        await render(); await press('开始模拟');
        await act(async () => { pending.source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'before retained-stack navigation' }]))); });
        expect(text()).toContain('before retained-stack navigation');
        await act(async () => { fixture.focused = false; renderer.update(React.createElement(TokenHubWorkMock)); });
        expect(pending.cancel).toHaveBeenCalledOnce();
        const request = fetcher.mock.calls.find((call: unknown[]) => String(call[0]).endsWith('/stream'))!;
        expect(request[1].signal.aborted).toBe(true); expect(renderer.toJSON()).not.toBeNull();
        fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : successful());
        await act(async () => { fixture.focused = true; renderer.update(React.createElement(TokenHubWorkMock)); });
        expect(text()).not.toContain('before retained-stack navigation'); await press('开始模拟'); expect(text()).toContain('已收到完成标记');
    });
});
