import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ draft: '', id: 0, storage: new Map<string, string>(), keys: new Map<string, string>(), logout: vi.fn(async () => {}), refresh: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class { getString(key: string) { return f.storage.get(key); } set(key: string, value: string) { f.storage.set(key, value); } } }));
vi.mock('expo-router', async () => { const R = await import('react'); return { useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: (callback: () => void) => R.useEffect(callback, [callback]) }; });
vi.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++f.id).padStart(12, '0')}` }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://work.example' }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/encryption/libsodium', () => ({ decryptSecretBox: (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) }));
vi.mock('@/components/AgentInput', async () => { const R = await import('react'); return { AgentInput: R.forwardRef((props: any, ref: any) => { R.useImperativeHandle(ref, () => ({ getText: () => f.draft, setTextAndSelection: (value: string) => { f.draft = value; } })); return R.createElement('AgentInput', props); }) }; });
vi.mock('./PlatformSessionProvider', () => ({ usePlatformSession: () => ({ logout: f.logout, refresh: f.refresh }) }));
import { TokenHubConversation } from './TokenHubConversation';
const ConversationComponent = TokenHubConversation as React.ComponentType<NonNullable<Parameters<typeof TokenHubConversation>[0]>>;
import { platformAccountScope, type PlatformSession } from './platformSession';
import type { PlatformConversation } from './platformConversationClient';

const session: PlatformSession = { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', sessionId: 'session-one', csrf: 'a'.repeat(43), expiresAt: Date.now() + 3600000 };
const id = '77344cfb-b237-445d-8c19-53fd24db9f2a', turnId = 'dab94a86-3d5a-49c6-9090-0bb1e9c0c4ac';
const record = (): PlatformConversation => ({ id, model: 'qwen-current', updatedAt: 10, turns: [{ id: turnId, user: 'server-only question', assistant: 'saved server answer', status: 'complete' }] });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
let renderer: ReturnType<typeof create>, fetcher: ReturnType<typeof vi.fn>, browser: EventTarget;
let records: Map<string, PlatformConversation>;
function server(url: string, init: RequestInit): Promise<Response> {
    if (url.endsWith('/models')) return Promise.resolve(json({ mode: 'real', billable: true, models: [{ id: 'qwen-current', name: 'Qwen' }] }));
    if (url.endsWith('/conversations')) return Promise.resolve(json({ conversations: [...records.values()].map(item => ({ id: item.id, model: item.model, title: item.turns[0]?.user || '', updatedAt: item.updatedAt, lastStatus: item.turns.at(-1)?.status })) }));
    if (url.endsWith('/conversations/import')) {
        const data = JSON.parse(init.body as string);
        if (!records.has(data.id)) records.set(data.id, { ...data, updatedAt: 20 });
        return Promise.resolve(json(records.get(data.id)));
    }
    if (url.includes('/conversations/')) {
        const key = url.split('/').at(-1)!;
        if (init.method === 'DELETE') { records.delete(key); return Promise.resolve(json({ deleted: true })); }
        return Promise.resolve(records.has(key) ? json(records.get(key)) : new Response('', { status: 404 }));
    }
    const input = JSON.parse(init.body as string), question = input.messages.at(-1).content;
    const usage = { model: input.model, requestId: input.requestId, inputTokens: 2, outputTokens: 3, mock: false, billable: true, accounting: 'core' as const };
    const saved = { id: input.conversationId, model: input.model, updatedAt: 30, turns: [...(records.get(input.conversationId)?.turns || []), { id: input.requestId, user: question, assistant: 'authoritative saved answer', status: 'complete' as const, usage }] };
    records.set(input.conversationId, saved);
    return Promise.resolve(new Response([{ type: 'delta', text: 'transient answer' }, { type: 'usage', ...usage }, { type: 'done' }].map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } }));
}
const composer = () => renderer.root.findByType('AgentInput');
const text = () => JSON.stringify(renderer.toJSON());
function button(label: string) { return renderer.root.findAllByType('Pressable').find((node: any) => node.props.children?.props?.children === label)!; }
async function press(label: string) { await act(async () => { button(label).props.onPress(); }); }
async function render(value = session, startNew = false) { await act(async () => { renderer = create(React.createElement(ConversationComponent, { platformSession: value, startNew })); }); }
async function send(value: string) { f.draft = value; await act(async () => composer().props.onChangeText(value)); await act(async () => { composer().props.onSend(); }); }
function legacy() {
    const scope = platformAccountScope(session);
    const value = [{ ...record(), turns: [{ user: 'private browser-only question', assistant: 'old local answer', status: 'complete' }] }];
    f.keys.set('tokenhub-platform-history-key:v1:' + scope, 'A'.repeat(43));
    f.storage.set(scope, Buffer.from(JSON.stringify(value)).toString('base64'));
    return new Map(f.storage);
}
beforeEach(() => {
    f.draft = ''; f.id = 0; f.storage.clear(); f.keys.clear(); f.logout.mockClear(); f.refresh.mockClear(); records = new Map(); browser = new EventTarget();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { location: { origin: 'https://work.example' }, addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser) });
    vi.stubGlobal('localStorage', { getItem: (key: string) => f.keys.get(key) ?? null, setItem: (key: string, value: string) => f.keys.set(key, value) });
    fetcher = vi.fn(server); vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('loads account history without reading a device identity or uploading browser records', async () => {
    const before = legacy(); records.set(id, record()); await render();
    expect(text()).toContain('saved server answer'); expect(text()).toContain('Browser-only conversations');
    expect(fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    for (const [, init] of fetcher.mock.calls) {
        expect(init.credentials).toBe('include'); expect(init.headers).toMatchObject({ 'x-tokenhub-csrf': session.csrf });
        expect(init.headers).not.toHaveProperty('Authorization'); expect(init).not.toHaveProperty('body');
    }
    expect(f.storage).toEqual(before);
});
it('does not send legacy turns before explicit destination confirmation and keeps the local ciphertext', async () => {
    const before = legacy(), keys = new Map(f.keys); await render(); await press('private browser-only question');
    expect(composer().props.blockSend).toBe(true); await send('must not upload');
    await press('Import this conversation'); expect(text()).toContain('https://work.example'); expect(text()).toContain(session.authority);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/import') || url.endsWith('/stream'))).toBe(false);
    await press('Cancel'); expect(fetcher.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(false);
    await press('Import this conversation'); await press('Confirm import');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/import'))).toHaveLength(1);
    expect(composer().props.blockSend).toBe(false); expect(f.storage).toEqual(before); expect(f.keys).toEqual(keys);
    await send('explicitly continue imported history');
    const payload = JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith('/stream'))![1].body as string);
    expect(payload.conversationId).toBe(id); expect(payload.messages).toEqual([{ role: 'user', content: 'private browser-only question' }, { role: 'assistant', content: 'old local answer' }, { role: 'user', content: 'explicitly continue imported history' }]);
});
it('new platform sends persist stable IDs and replace optimistic content with server truth', async () => {
    await render(); await send('first cloud message'); await send('follow up');
    const calls = fetcher.mock.calls.filter(([url]) => url.endsWith('/stream'));
    expect(calls).toHaveLength(2);
    const a = JSON.parse(calls[0][1].body as string), b = JSON.parse(calls[1][1].body as string);
    expect(b.conversationId).toBe(a.conversationId); expect(b.requestId).not.toBe(a.requestId);
    expect(records.get(a.conversationId)?.turns.map(turn => turn.id)).toEqual([a.requestId, b.requestId]);
    expect(b.messages[1].content).toBe('authoritative saved answer'); expect(text()).not.toContain('transient answer');
    expect(f.storage.size).toBe(0); expect(f.keys.size).toBe(0);
});
it('requires delete confirmation and never deletes a browser copy', async () => {
    const before = legacy(); records.set(id, record()); await render(); await press('Delete account conversation');
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false);
    await press('Cancel'); expect(records.has(id)).toBe(true);
    await press('Delete account conversation'); await press('Confirm delete');
    expect(records.has(id)).toBe(false); expect(f.storage).toEqual(before); expect(text()).toContain('private browser-only question');
});
it('keeps previous cloud and local records when list refresh fails', async () => {
    legacy(); records.set(id, record()); await render();
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/conversations') ? Promise.resolve(new Response('', { status: 503 })) : server(url, init));
    await press('Reload history and models');
    expect(text()).toContain('saved server answer'); expect(text()).toContain('private browser-only question');
    expect(text()).toContain('Account history could not be refreshed');
});
it('keeps a remote streaming turn in progress rather than converting it into a local failure', async () => {
    records.set(id, { ...record(), turns: [{ ...record().turns[0], status: 'streaming' }] }); await render();
    expect(text()).toContain('server is still processing'); expect(text()).not.toContain('Request failed');
    expect(composer().props.blockSend).toBe(true); await send('do not start second inference');
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/stream'))).toBe(false);
    records.set(id, record()); await press('Reload history and models'); expect(composer().props.blockSend).toBe(false);
});
it('reconciles an aborted stream using a fresh read and never retries inference', async () => {
    fetcher.mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.endsWith('/stream')) return server(url, init);
        const input = JSON.parse(init.body as string);
        records.set(input.conversationId, { id: input.conversationId, model: input.model, updatedAt: 30, turns: [{ id: input.requestId, user: input.messages[0].content, assistant: 'saved partial', status: 'cancelled' }] });
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'delta', text: 'partial transport' }) + '\n')); } }), { headers: { 'content-type': 'application/x-ndjson' } });
    });
    await render(); await send('stop this'); expect(composer().props.isSending).toBe(true);
    await act(async () => composer().props.onAbort());
    expect(text()).toContain('saved partial'); expect(text()).toContain('Stopped');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1);
    const reads = fetcher.mock.calls.filter(([url]) => url.includes('/conversations/'));
    expect(reads.length).toBeGreaterThan(0); expect(reads.at(-1)![1].signal?.aborted).toBe(false);
});
it('reconciles a failed stream without starting another inference request', async () => {
    fetcher.mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.endsWith('/stream')) return server(url, init);
        const input = JSON.parse(init.body as string);
        records.set(input.conversationId, { id: input.conversationId, model: input.model, updatedAt: 30, turns: [{ id: input.requestId, user: input.messages[0].content, assistant: 'server retained failure', status: 'failed' }] });
        throw new Error('network lost after acceptance');
    });
    await render(); await send('retain accepted user message');
    expect(text()).toContain('server retained failure'); expect(text()).toContain('Request failed');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1);
});
it('aborts browser blur requests and ignores late data after an account/session switch', async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/conversations') ? new Promise<Response>(done => { resolve = done; }) : server(url, init));
    await render(); const stale = resolve, firstRead = fetcher.mock.calls.find(([url]) => url.endsWith('/conversations'))![1];
    await act(async () => browser.dispatchEvent(new Event('blur'))); expect(firstRead.signal?.aborted).toBe(true);
    fetcher.mockImplementation(server);
    await act(async () => renderer.update(React.createElement(ConversationComponent, { platformSession: { ...session, subject: '99', sessionId: 'session-two', csrf: 'b'.repeat(43) } })));
    await act(async () => stale(json({ conversations: [{ id, model: 'qwen-current', title: 'other account private title', updatedAt: 1 }] })));
    expect(text()).not.toContain('other account private title'); expect(composer().props.blockSend).toBe(false);
});
it('clears visible account data and invalidates late history on logout', async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/conversations') ? new Promise<Response>(done => { resolve = done; }) : server(url, init));
    legacy(); await render(); await press('Sign out of Work');
    await act(async () => resolve(json({ conversations: [{ id, model: 'qwen-current', title: 'late private account title', updatedAt: 1 }] })));
    expect(f.logout).toHaveBeenCalledOnce(); expect(text()).not.toContain('late private account title'); expect(text()).not.toContain('private browser-only question');
    const count = fetcher.mock.calls.length; await act(async () => browser.dispatchEvent(new Event('focus'))); expect(fetcher).toHaveBeenCalledTimes(count);
});
it('an unreadable legacy vault and missing key are never overwritten by new cloud sends', async () => {
    const scope = platformAccountScope(session); f.storage.set(scope, 'unreadable-ciphertext'); await render(); await send('new cloud history');
    expect(f.storage.get(scope)).toBe('unreadable-ciphertext'); expect(f.keys.size).toBe(0); expect(text()).toContain('encrypted data and key have not been changed');
});

it('marks an authoritative missing conversation unsaved without dropping partial content or replaying it', async () => {
    fetcher.mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.endsWith('/stream')) return server(url, init);
        return new Response(JSON.stringify({ type: 'delta', text: 'unsaved partial' }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    });
    await render(); await send('keep this unsaved question');
    expect(text()).toContain('keep this unsaved question'); expect(text()).toContain('unsaved partial');
    expect(text()).toContain('Not saved on the server'); expect(text()).not.toContain('server is still processing');
    expect(composer().props.blockSend).toBe(true); await send('must not retry missing id');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1);
    await press('New conversation'); expect(composer().props.blockSend).toBe(false);
});
it('keeps an unknown history failure pending and retries only reads while server state is unresolved', async () => {
    vi.useFakeTimers();
    records.set(id, { ...record(), turns: [{ ...record().turns[0], status: 'streaming' }] }); await render();
    fetcher.mockImplementation((url: string, init: RequestInit) => url.includes('/conversations/') ? Promise.resolve(new Response('', { status: 503 })) : server(url, init));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(text()).toContain('server is still processing'); expect(composer().props.blockSend).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/conversations/')).length).toBeGreaterThan(1);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/stream'))).toBe(false);
});
it('stops history polling on expired authentication and refreshes the login session', async () => {
    vi.useFakeTimers();
    records.set(id, { ...record(), turns: [{ ...record().turns[0], status: 'streaming' }] }); await render();
    fetcher.mockImplementation((url: string, init: RequestInit) => url.includes('/conversations/') ? Promise.resolve(new Response('', { status: 401 })) : server(url, init));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const count = fetcher.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(fetcher).toHaveBeenCalledTimes(count); expect(f.refresh).toHaveBeenCalledOnce();
    expect(text()).toContain('authorization has expired'); expect(composer().props.blockSend).toBe(true);
});

it('a late list response cannot resurrect a confirmed deleted account conversation', async () => {
    records.set(id, record()); await render();
    let resolve!: (response: Response) => void;
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/conversations') ? new Promise<Response>(done => { resolve = done; }) : server(url, init));
    await press('Reload history and models'); await press('Delete account conversation'); await press('Confirm delete');
    await act(async () => resolve(json({ conversations: [{ id, model: 'qwen-current', title: 'server-only question', updatedAt: 10, lastStatus: 'complete' }] })));
    expect(records.has(id)).toBe(false); expect(text()).not.toContain('server-only question');
});


it('explains disabled basic chat and clears its error when models recover on foreground refresh', async () => {
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/models')
        ? Promise.resolve(new Response(JSON.stringify({ code: 'work_gateway_disabled', error: 'private upstream detail' }), { status: 503, headers: { 'content-type': 'application/json' } })) : server(url, init));
    await render();
    expect(text()).toContain('select a group and models in TokenHub Work settings');
    expect(text()).not.toContain('private upstream detail');
    expect(composer().props.blockSend).toBe(true);
    await send('must not send'); expect(fetcher.mock.calls.some(([url]) => url.endsWith('/stream'))).toBe(false);
    fetcher.mockImplementation(server);
    await act(async () => { browser.dispatchEvent(new Event('focus')); });
    expect(text()).not.toContain('TokenHub chat is not enabled');
    expect(composer().props.blockSend).toBe(false);
});
it('refreshes login after a catalog authorization expires without enabling sending', async () => {
    fetcher.mockImplementation((url: string, init: RequestInit) => url.endsWith('/models')
        ? Promise.resolve(new Response('', { status: 401 })) : server(url, init));
    await render();
    expect(text()).toContain('Your authorization has expired');
    expect(f.refresh).toHaveBeenCalled(); expect(composer().props.blockSend).toBe(true);
});
