vi.mock('./PlatformNavigation', () => ({ usePlatformNavigationRegistration: vi.fn() }));
vi.mock('./PlatformChatContent', async () => { const R = await import('react'); return { PlatformChatContent: (p: any) => R.createElement('PlatformChatContent', p, ...p.turns.map((turn: any, i: number) => R.createElement('Text', { key: i }, turn.user + ' ' + turn.assistant + ' ' + turn.status))) }; });
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('./PlatformConversationShell', async () => { const R = await import('react'); return { PlatformConversationShell: (p: any) => R.createElement('View', null, p.actions, p.sidebar?.(() => {}), R.createElement('Pressable', { onPress: p.onNew, disabled: p.busy }, R.createElement('Text', null, p.newLabel)), p.children, p.composer) }; });
vi.mock('@/components/Item', async () => { const R = await import('react'); return { Item: (p: any) => R.createElement('Pressable', { onPress: p.onPress, disabled: p.disabled }, R.createElement('Text', null, p.title)) }; });
vi.mock('@/components/markdown/MarkdownView', async () => { const R = await import('react'); return { MarkdownView: (p: any) => R.createElement('Text', null, p.markdown) }; });
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
    credentials: { token: '', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    server: 'https://work.example', draft: '', id: 0,
    storage: new Map<string, string>(), writes: [] as { key: string; value: string }[], routeContext: null as any, focusContext: null as any,
    dismissTo: vi.fn(), push: vi.fn(), tokenHub: true, authenticated: true,
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return f.storage.get(key); }
    set(key: string, value: string) { f.storage.set(key, value); f.writes.push({ key, value }); }
} }));
vi.mock('expo-router', async () => {
    const R = await import('react');
    f.routeContext = R.createContext({});
    f.focusContext = R.createContext(true);
    return {
        useRouter: () => ({ dismissTo: f.dismissTo, push: f.push }),
        useLocalSearchParams: () => R.useContext(f.routeContext),
        useFocusEffect: (effect: () => void | (() => void)) => {
            const focused = R.useContext(f.focusContext);
            R.useEffect(() => focused ? effect() : undefined, [effect, focused]);
        },
        Redirect: 'Redirect',
    };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++f.id).padStart(12, '0')}` }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: f.credentials, isAuthenticated: f.authenticated }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => f.server }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/encryption/libsodium', () => ({
    encryptSecretBox: (value: unknown) => new TextEncoder().encode(JSON.stringify(value)),
    decryptSecretBox: (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)),
}));
vi.mock('@/components/AgentInput', async () => {
    const R = await import('react');
    return { AgentInput: R.forwardRef((props: any, ref: any) => {
        R.useImperativeHandle(ref, () => ({ getText: () => f.draft, setTextAndSelection: (text: string) => { f.draft = text; } }));
        return R.createElement('AgentInput', props);
    }) };
});
vi.mock('./sessionSource', () => ({ isTokenHubSessionForUI: () => f.tokenHub }));

import { accountScope, TokenHubHomeConversation } from './TokenHubConversation';
import { NewSessionEntry } from './NewSessionEntry';

let renderer: ReturnType<typeof create> | undefined;
let fetcher: ReturnType<typeof vi.fn>;
let intent: string | undefined;
const tokenFor = (subject: string) => `head.${Buffer.from(JSON.stringify({ sub: subject, iss: 'handy' })).toString('base64url')}.sig`;
const catalog = (model = 'glm-5') => new Response(JSON.stringify({ mode: 'real', billable: true, models: [{ id: model, name: model }] }), { headers: { 'content-type': 'application/json' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function completion(init: RequestInit) {
    const input = JSON.parse(init.body as string);
    return new Response([
        { type: 'delta', text: 'answer' },
        { type: 'usage', model: input.model, requestId: input.requestId, inputTokens: 5, outputTokens: 2, mock: false, billable: true, accounting: 'core' },
        { type: 'done' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
}

// Expo Stack keeps earlier screens mounted. Preserve that overlap until the real
// entry requests dismissTo, then apply its POP_TO params to the existing Home.
function StackFixture({ home, entry, newChat, mode, homeFocused }: { home: boolean; entry: boolean; newChat?: string; mode?: string; homeFocused: boolean }) {
    return React.createElement(React.Fragment, null,
        home ? React.createElement(f.routeContext.Provider, { key: 'home', value: { newChat } },
            React.createElement(f.focusContext.Provider, { value: homeFocused }, React.createElement(TokenHubHomeConversation))) : null,
        entry ? React.createElement(f.routeContext.Provider, { key: 'entry', value: { mode } },
            React.createElement(NewSessionEntry, null, React.createElement('LegacyDeviceComposer'))) : null,
    );
}
async function renderStack({ home = true, entry = false, newChat = intent, mode, homeFocused = !entry }: { home?: boolean; entry?: boolean; newChat?: string; mode?: string; homeFocused?: boolean } = {}) {
    intent = newChat;
    await act(async () => {
        const tree = React.createElement(StackFixture, { home, entry, newChat, mode, homeFocused });
        if (renderer) renderer.update(tree); else renderer = create(tree);
        await tick();
    });
}
function composer() { return renderer!.root.findByType('AgentInput'); }
function composers() { return renderer!.root.findAllByType('AgentInput'); }
function requests(suffix: string) { return fetcher.mock.calls.filter(([url]) => url.endsWith(suffix)); }
function streamInputs() { return requests('/stream').map(([, init]) => JSON.parse(init.body as string)); }
function saved(subject = 'alice') {
    const value = f.storage.get(accountScope(f.server, tokenFor(subject)));
    return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : [];
}
async function send(text: string) {
    f.draft = text;
    await act(async () => composer().props.onChangeText(text));
    await act(async () => { composer().props.onSend(); await tick(); });
}
async function applyDismiss() {
    const destination = f.dismissTo.mock.calls.at(-1)?.[0];
    expect(destination?.pathname).toBe('/');
    expect(typeof destination?.params?.newChat).toBe('string');
    expect(destination.params.newChat).not.toBe('');
    await renderStack({ newChat: destination.params.newChat });
    return destination.params.newChat as string;
}
async function newConversation() {
    const count = f.dismissTo.mock.calls.length;
    await renderStack({ entry: true });
    expect(f.dismissTo).toHaveBeenCalledTimes(count + 1);
    return applyDismiss();
}
async function unmount() {
    if (renderer) await act(async () => renderer!.unmount());
    renderer = undefined;
}
beforeEach(() => {
    intent = undefined;
    f.credentials = { token: tokenFor('alice'), secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    f.server = 'https://work.example'; f.draft = ''; f.id = 0;
    f.storage.clear(); f.writes = []; f.dismissTo.mockClear(); f.push.mockClear();
    f.tokenHub = true; f.authenticated = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetcher = vi.fn(async (url: string, init: RequestInit) => url.endsWith('/models') ? catalog() : completion(init));
    vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { await unmount(); vi.unstubAllGlobals(); });

it('keeps one history owner during Home /new overlap and retains both conversations after back and cleanup', async () => {
    await renderStack(); await send('home conversation');
    const catalogCount = requests('/models').length;
    await renderStack({ entry: true });
    expect(composers()).toHaveLength(1);
    expect(renderer!.root.findAllByType('LegacyDeviceComposer')).toHaveLength(0);
    expect(requests('/models')).toHaveLength(catalogCount);
    await applyDismiss(); await send('new route conversation');
    expect(composers()).toHaveLength(1);
    expect(streamInputs().at(-1).messages).toEqual([{ role: 'user', content: 'new route conversation' }]);
    expect(JSON.stringify(renderer!.toJSON())).toContain('home conversation');
    expect(JSON.stringify(renderer!.toJSON())).toContain('new route conversation');
    await unmount(); intent = undefined; await renderStack();
    expect(JSON.stringify(renderer!.toJSON())).toContain('home conversation');
    expect(JSON.stringify(renderer!.toJSON())).toContain('new route conversation');
    expect(saved()).toHaveLength(2);
});

it('starts fresh for repeated unique intents but keeps the active conversation for the unchanged intent', async () => {
    await renderStack(); await send('first');
    const firstIntent = await newConversation(); await send('second');
    const secondIntent = await newConversation(); await send('third');
    expect(secondIntent).not.toBe(firstIntent);
    expect(streamInputs().map(input => input.messages)).toEqual([
        [{ role: 'user', content: 'first' }], [{ role: 'user', content: 'second' }], [{ role: 'user', content: 'third' }],
    ]);
    const catalogCount = requests('/models').length;
    await renderStack(); await send('same conversation followup');
    expect(requests('/models')).toHaveLength(catalogCount);
    expect(streamInputs().at(-1).messages).toEqual([
        { role: 'user', content: 'third' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'same conversation followup' },
    ]);
    await unmount();
    expect(saved()).toHaveLength(3);
});

it('handles a cold /new deep link without starting a transient catalog or history owner', async () => {
    await renderStack({ home: false, entry: true });
    expect(composers()).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.dismissTo).toHaveBeenCalledTimes(1);
    await applyDismiss();
    expect(composers()).toHaveLength(1);
    expect(requests('/models')).toHaveLength(1);
    await send('cold link conversation');
    expect(streamInputs()[0].messages).toEqual([{ role: 'user', content: 'cold link conversation' }]);
});

it('aborts the replaced Home catalog and ignores its late stale result', async () => {
    let resolveOld!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
    await renderStack();
    const oldSignal = requests('/models')[0][1].signal as AbortSignal;
    expect(composer().props.blockSend).toBe(true);
    await newConversation();
    expect(oldSignal.aborted).toBe(true);
    expect(composer().props.availableModels.map((model: any) => model.key)).toEqual(['glm-5']);
    await act(async () => { resolveOld(catalog('stale-model')); await tick(); });
    expect(composer().props.availableModels.map((model: any) => model.key)).toEqual(['glm-5']);
    await send('only current model');
    expect(streamInputs()[0].model).toBe('glm-5');
});

it('aborts an in-flight request before new Home initialization and retains reconciliation blocking', async () => {
    let resolveStream!: (response: Response) => void;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : new Promise<Response>(resolve => { resolveStream = resolve; }));
    await renderStack(); await send('interrupted old request');
    const oldCall = requests('/stream')[0];
    expect(composer().props.isSending).toBe(true);
    await newConversation();
    expect((oldCall[1].signal as AbortSignal).aborted).toBe(true);
    expect(composer().props.isSending).toBe(false);
    expect(composer().props.blockSend).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain('Usage reconciliation is pending');
    expect(saved()[0].turns[0].user).toBe('interrupted old request');
    await send('must not send while unresolved');
    expect(requests('/stream')).toHaveLength(1);
    await act(async () => { resolveStream(completion(oldCall[1])); await tick(); });
    expect(composer().props.blockSend).toBe(true);
    await unmount();
    expect(saved()[0].turns[0].status).toBe('failed');
});

it('isolates history and request credentials across accounts even when the new-chat intent is unchanged', async () => {
    await renderStack(); await send('alice private');
    await newConversation(); await send('alice new');
    f.credentials = { ...f.credentials, token: tokenFor('bob') };
    await renderStack();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('alice private');
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('alice new');
    await send('bob private');
    const lastCall = requests('/stream').at(-1);
    expect(lastCall![1].headers.Authorization).toBe(`Bearer ${tokenFor('bob')}`);
    expect(streamInputs().at(-1).messages).toEqual([{ role: 'user', content: 'bob private' }]);
    expect(JSON.stringify(saved('alice'))).toContain('alice new');
    expect(JSON.stringify(saved('alice'))).not.toContain('bob private');
    expect(JSON.stringify(saved('bob'))).not.toContain('alice');
    f.credentials = { ...f.credentials, token: tokenFor('alice') };
    await renderStack();
    expect(JSON.stringify(renderer!.toJSON())).toContain('alice private');
    expect(JSON.stringify(renderer!.toJSON())).toContain('alice new');
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('bob private');
});

it('persists and aborts exactly once on blur, without a stale second write when the inactive Home unmounts', async () => {
    let resolveStream!: (response: Response) => void;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/models') ? catalog() : new Promise<Response>(resolve => { resolveStream = resolve; }));
    await renderStack(); await send('request at blur');
    const oldCall = requests('/stream')[0];
    const writesBefore = f.writes.length;
    await renderStack({ homeFocused: false });
    expect((oldCall[1].signal as AbortSignal).aborted).toBe(true);
    expect(f.writes).toHaveLength(writesBefore + 1);
    await act(async () => { resolveStream(completion(oldCall[1])); await tick(); });
    await unmount();
    expect(f.writes).toHaveLength(writesBefore + 1);
    expect(saved()[0].turns[0].user).toBe('request at blur');
});

it('reloads on refocus without treating the already-consumed new-chat intent as another reset', async () => {
    fetcher.mockImplementation(async (url: string, init: RequestInit) => url.endsWith('/models')
        ? new Response(JSON.stringify({ mode: 'real', billable: true, models: [{ id: 'first-model', name: 'First' }, { id: 'glm-5', name: 'GLM' }] }), { headers: { 'content-type': 'application/json' } })
        : completion(init));
    await renderStack(); await newConversation();
    await act(async () => composer().props.onModelModeChange({ key: 'glm-5', name: 'GLM' }));
    await send('keep selected chat');
    f.draft = 'draft while away';
    await act(async () => composer().props.onChangeText(f.draft));
    const catalogCount = requests('/models').length;
    await renderStack({ homeFocused: false });
    expect(requests('/models')).toHaveLength(catalogCount);
    await renderStack({ homeFocused: true });
    expect(requests('/models')).toHaveLength(catalogCount + 1);
    expect(composer().props.modelMode.key).toBe('glm-5');
    expect(f.draft).toBe('draft while away');
    expect(composer().props.isSendDisabled).toBe(false);
    await send('after return from settings');
    expect(streamInputs().at(-1).messages).toEqual([
        { role: 'user', content: 'keep selected chat' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'after return from settings' },
    ]);
});

it('allows only the focused retained Home to own persistence and restores newer history when going back', async () => {
    function RetainedHomes({ focused }: { focused: 'older' | 'newer' }) {
        return React.createElement(React.Fragment, null, ...(['older', 'newer'] as const).map(name =>
            React.createElement(f.routeContext.Provider, { key: name, value: { newChat: name === 'newer' ? 'newer-intent' : undefined } },
                React.createElement(f.focusContext.Provider, { value: focused === name }, React.createElement(TokenHubHomeConversation))),
        ));
    }
    async function show(focused: 'older' | 'newer') {
        await act(async () => {
            const tree = React.createElement(RetainedHomes, { focused });
            if (renderer) renderer.update(tree); else renderer = create(tree);
            await tick();
        });
    }
    async function sendAt(index: number, text: string) {
        f.draft = text;
        await act(async () => composers()[index].props.onChangeText(text));
        await act(async () => { composers()[index].props.onSend(); await tick(); });
    }
    await show('older');
    expect(requests('/models')).toHaveLength(1);
    await sendAt(0, 'older home conversation');
    await show('newer');
    expect(requests('/models')).toHaveLength(2);
    const streamCount = requests('/stream').length;
    await sendAt(0, 'hidden older must not send');
    expect(requests('/stream')).toHaveLength(streamCount);
    await sendAt(1, 'newer home conversation');
    expect(streamInputs().at(-1).messages).toEqual([{ role: 'user', content: 'newer home conversation' }]);
    await show('older');
    expect(requests('/models')).toHaveLength(3);
    expect(JSON.stringify(renderer!.toJSON())).toContain('newer home conversation');
    await sendAt(0, 'older followup');
    expect(streamInputs().at(-1).messages).toEqual([
        { role: 'user', content: 'older home conversation' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'older followup' },
    ]);
    await unmount();
    expect(saved()).toHaveLength(2);
    expect(JSON.stringify(saved())).toContain('newer home conversation');
    expect(JSON.stringify(saved())).toContain('older followup');
});
