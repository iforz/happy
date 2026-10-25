import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { v5 as uuidv5 } from 'uuid';
import { MMKV } from 'react-native-mmkv';
import { useUnistyles } from 'react-native-unistyles';
import { PlatformConversationShell } from './PlatformConversationShell';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { PlatformChatContent } from './PlatformChatContent';
import { usePlatformNavigationRegistration } from './PlatformNavigation';
import { AgentInput } from '@/components/AgentInput';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { getServerUrl } from '@/sync/serverConfig';
import { decryptSecretBox } from '@/encryption/libsodium';
import { decodeBase64 } from '@/encryption/base64';
import { usePlatformSession } from './PlatformSessionProvider';
import { platformAccountScope, type PlatformSession } from './platformSession';
import { readPlatformHistoryKey } from './platformHistory';
import { createPlatformConversationClient, type PlatformConversation, type PlatformConversationSummary } from './platformConversationClient';
import { createWorkMockClient, WorkMockError, type WorkModelCatalog } from './workMockClient';
import { conversationInput, requireRealCatalog, selectedModelAllowed, type Conversation, type Turn } from './conversation';
import { tokenHubFetch } from './transport';
import { workText as t } from './workText';

const legacyStorage = new MMKV({ id: 'tokenhub-conversations-v1' });
const IMPORT_NAMESPACE = 'b1bf4161-4457-4d38-b5dd-540d94751f0d';
type Selection = { kind: 'cloud' | 'local'; id: string } | null;
function summary(value: PlatformConversation): PlatformConversationSummary {
    return { id: value.id, model: value.model, title: value.turns[0]?.user.slice(0, 200) || t('newChat'), updatedAt: value.updatedAt, lastStatus: value.turns.at(-1)?.status };
}
function requestFailure(cause: unknown): string {
    if (!(cause instanceof WorkMockError)) return t('requestError');
    if (cause.kind === 'authentication') return t('authentication');
    if (cause.kind === 'forbidden') return t('forbidden');
    if (cause.kind === 'quota_exceeded') return t('quota');
    if (cause.kind === 'rate_limit') return t('rateLimit');
    if (cause.kind === 'invalid_request') return t('contextLimit');
    return t('requestError');
}

/** Cookie account history never writes or automatically imports the old browser vault. */
export function PlatformAccountConversation({ session, startNew = false, initialConversationId }: { session: PlatformSession; startNew?: boolean; initialConversationId?: string }) {
    const router = useRouter(), platform = usePlatformSession(), { theme } = useUnistyles();
    const server = getServerUrl(), scope = platformAccountScope(session, server);
    const client = React.useMemo(() => createWorkMockClient({ baseUrl: server, requireRealCatalog: true, tokenProvider: async () => null,
        fetch: tokenHubFetch, platformSession: { csrf: session.csrf, origin: window.location.origin } }), [server, session.csrf]);
    const history = React.useMemo(() => createPlatformConversationClient({ baseUrl: server, csrf: session.csrf, origin: window.location.origin, fetch: tokenHubFetch }), [server, session.csrf]);
    const composer = React.useRef<MultiTextInputHandle>(null);
    const epoch = React.useRef(0), alive = React.useRef(false), signedOut = React.useRef(false), detailVersion = React.useRef(0), listVersion = React.useRef(0);
    const activeMutation = React.useRef<AbortController | null>(null), pendingDetail = React.useRef<AbortController | null>(null);
    const requests = React.useRef(new Set<AbortController>()), activeStream = React.useRef<AbortController | null>(null);
    const selectionRef = React.useRef<Selection>(null), initial = React.useRef(true);
    const [selection, setSelection] = React.useState<Selection>(null);
    const [conversations, setConversations] = React.useState<PlatformConversationSummary[]>([]);
    const [current, setCurrent] = React.useState<PlatformConversation | null>(null);
    const [missingConversation, setMissingConversation] = React.useState<string | null>(null);
    const [local, setLocal] = React.useState<Conversation[]>([]);
    const [catalog, setCatalog] = React.useState<WorkModelCatalog | null>(null), [model, setModel] = React.useState('');
    const [catalogError, setCatalogError] = React.useState('');
    const [chatDisabled, setChatDisabled] = React.useState(false);
    const [loading, setLoading] = React.useState(true), [historyLoading, setHistoryLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false), [mutating, setMutating] = React.useState(false), [engaged, setEngaged] = React.useState(false);
    const [draft, setDraft] = React.useState(''), [error, setError] = React.useState(''), [historyError, setHistoryError] = React.useState(''), [detailError, setDetailError] = React.useState(''), [localError, setLocalError] = React.useState('');
    const [confirmation, setConfirmation] = React.useState<{ kind: 'import' | 'delete'; id: string } | null>(null);
    const [reload, setReload] = React.useState(0);
    const localCurrent = selection?.kind === 'local' ? local.find(item => item.id === selection.id) : undefined;
    const shown = localCurrent ?? current;
    const serverStreaming = current?.id !== missingConversation && !!current?.turns.some(turn => turn.status === 'streaming');
    const validModel = selectedModelAllowed(catalog, model);
    const currentEpoch = (value: number) => alive.current && epoch.current === value;
    function choose(value: Selection) { selectionRef.current = value; setSelection(value); setConfirmation(null); }
    function controller() { const value = new AbortController(); requests.current.add(value); return value; }
    function stop() {
        alive.current = false; epoch.current++; detailVersion.current++;
        requests.current.forEach(value => value.abort()); requests.current.clear();
        activeStream.current?.abort(); activeStream.current = null; activeMutation.current = null;
    }
    function authenticationFailed() {
        stop(); setEngaged(false); setBusy(false); setMutating(false); setLoading(false); setHistoryLoading(false); setError(t('authentication'));
        void platform.refresh?.();
    }
    function resetComposer() { composer.current?.setTextAndSelection('', { start: 0, end: 0 }); setDraft(''); }
    function updateSummary(value: PlatformConversation) { setConversations(items => [summary(value), ...items.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)); }
    async function loadConversation(id: string, generation: number, indicate = true, keepModel = false): Promise<void> {
        if (!indicate && pendingDetail.current && !pendingDetail.current.signal.aborted) return;
        pendingDetail.current?.abort();
        const version = ++detailVersion.current, request = controller(); pendingDetail.current = request;
        if (indicate) setHistoryLoading(true);
        try {
            const value = await history.get(id, request.signal);
            if (!currentEpoch(generation) || version !== detailVersion.current || selectionRef.current?.kind !== 'cloud' || selectionRef.current.id !== id) return;
            setCurrent(value); setMissingConversation(null); updateSummary(value); setDetailError('');
            if (!keepModel) setModel(value.model);
        } catch (cause) {
            if (currentEpoch(generation) && version === detailVersion.current && !request.signal.aborted) {
                if (cause instanceof WorkMockError && ['authentication', 'forbidden'].includes(cause.kind)) authenticationFailed();
                else if (cause instanceof WorkMockError && cause.status === 404) {
                    // An authoritative absence is not a live stream. Keep visible partial content,
                    // but never retry this ID or silently turn it into a new server conversation.
                    setMissingConversation(id); setDetailError(t('conversationMissing'));
                } else setDetailError(t('historyError'));
            }
        } finally {
            requests.current.delete(request);
            if (pendingDetail.current === request) pendingDetail.current = null;
            if (currentEpoch(generation) && version === detailVersion.current) setHistoryLoading(false);
        }
    }
    async function loadList(generation: number): Promise<void> {
        const version = ++listVersion.current, request = controller();
        try {
            const values = await history.list(request.signal);
            if (!currentEpoch(generation)) return;
            if (version !== listVersion.current) return;
            setConversations(values); setHistoryError('');
            if (initial.current) {
                initial.current = false;
                const id = initialConversationId || values[0]?.id;
                if (!startNew && !selectionRef.current && id) { choose({ kind: 'cloud', id }); await loadConversation(id, generation); }
            }
        } catch (cause) {
            // A failed read is not an empty account. Keep already loaded cloud and local records.
            if (currentEpoch(generation) && version === listVersion.current && !request.signal.aborted) {
                if (cause instanceof WorkMockError && ['authentication', 'forbidden'].includes(cause.kind)) authenticationFailed();
                else setHistoryError(t('historyError'));
            }
        } finally { requests.current.delete(request); }
    }
    useFocusEffect(React.useCallback(() => {
        function foreground() {
            if (signedOut.current) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            stop(); alive.current = true; setEngaged(true); setBusy(false); setMutating(false); setHistoryLoading(false);
            const generation = epoch.current, request = controller();
            setLoading(true); setCatalog(null);
            try {
                const ciphertext = legacyStorage.getString(scope);
                if (ciphertext) {
                    const key = readPlatformHistoryKey(scope);
                    if (!key) throw new Error('Missing legacy key');
                    const decoded = decryptSecretBox(decodeBase64(ciphertext, 'base64'), decodeBase64(key, 'base64url'));
                    if (!Array.isArray(decoded) || decoded.length > 100 || !decoded.every(item => typeof item?.id === 'string' && !!item.id && typeof item?.model === 'string' && !!item.model && Array.isArray(item.turns)
                        && item.turns.every((turn: Turn) => typeof turn?.user === 'string' && typeof turn?.assistant === 'string' && ['streaming', 'complete', 'cancelled', 'failed'].includes(turn.status)))) throw new Error('Unreadable legacy history');
                    setLocal(decoded); setLocalError('');
                }
            } catch { setLocalError(t('legacyHistoryError')); }
            void client.getCatalog(request.signal).then(value => {
                requireRealCatalog(value);
                if (!currentEpoch(generation)) return;
                setChatDisabled(false); setCatalogError(''); setCatalog(value); setModel(previous => previous || value.models[0]?.id || '');
            }).catch(cause => {
                if (!currentEpoch(generation) || request.signal.aborted) return;
                if (cause instanceof WorkMockError && cause.kind === 'authentication') { authenticationFailed(); return; }
                const diagnostic = cause instanceof WorkMockError ? cause.diagnostic : undefined;
                setChatDisabled(diagnostic === 'work_gateway_disabled');
                setCatalogError(t(diagnostic === 'work_gateway_disabled' ? 'catalogDisabled'
                    : diagnostic === 'work_gateway_unavailable' ? 'catalogServiceUnavailable'
                    : diagnostic === 'work_authority_unavailable' ? 'catalogAuthorityUnavailable'
                    : diagnostic === 'work_key_lookup_unavailable' ? 'catalogKeyUnavailable'
                    : cause instanceof WorkMockError && cause.kind === 'forbidden' ? 'forbidden' : 'catalogError'));
            })
                .finally(() => { requests.current.delete(request); if (currentEpoch(generation)) setLoading(false); });
            void loadList(generation);
            if (selectionRef.current?.kind === 'cloud') void loadConversation(selectionRef.current.id, generation, true, true);
        }
        const background = () => { stop(); setEngaged(false); setBusy(false); setConfirmation(null); };
        const visibility = () => { if (document.visibilityState === 'hidden') background(); else foreground(); };
        foreground();
        window.addEventListener?.('focus', foreground); window.addEventListener?.('blur', background);
        if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', visibility);
        return () => { stop(); window.removeEventListener?.('focus', foreground); window.removeEventListener?.('blur', background); if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', visibility); };
    }, [client, history, scope, session.sessionId, reload]));
    // Read-only reconciliation can wait for an in-flight turn from this or another device.
    // Never replay inference or classify somebody else's stream as a local failure.
    React.useEffect(() => {
        if (!engaged || busy || !serverStreaming || selection?.kind !== 'cloud') return;
        const id = selection.id;
        const timer = setInterval(() => { if (alive.current) void loadConversation(id, epoch.current, false, true); }, 2000);
        return () => clearInterval(timer);
    }, [engaged, busy, serverStreaming, selection?.kind, selection?.id, history]);
    function newConversation() {
        if (busy || mutating) return;
        initial.current = false; detailVersion.current++; choose(null); setCurrent(null); setMissingConversation(null); setHistoryLoading(false); setDetailError(''); setError(''); resetComposer();
    }
    async function send(textOverride?: string) {
        if (!alive.current || activeStream.current || busy || mutating || loading || historyLoading || !validModel || selectionRef.current?.kind === 'local' || serverStreaming || !!missingConversation || (selectionRef.current?.kind === 'cloud' && !current)) return;
        const question = (textOverride ?? composer.current?.getText() ?? '').trim();
        if (!question) return;
        let messages;
        try { messages = conversationInput(current?.turns || [], question); } catch { setError(t('contextLimit')); return; }
        const id = current?.id || randomUUID(), requestId = randomUUID(), generation = epoch.current;
        const request = controller(); activeStream.current = request; listVersion.current++;
        const turn = { id: requestId, user: question, assistant: '', status: 'streaming' as const };
        const base: PlatformConversation = { id, model, updatedAt: Date.now(), turns: [...(current?.turns || []), turn] };
        choose({ kind: 'cloud', id }); setCurrent(base); updateSummary(base); setBusy(true); setError(''); resetComposer();
        try {
            await client.stream({ model, messages, requestId, conversationId: id }, text => {
                if (!currentEpoch(generation)) return;
                turn.assistant += text;
                setCurrent(value => value?.id === id ? { ...value, turns: value.turns.map(item => item.id === requestId ? { ...turn } : item) } : value);
            }, request.signal);
        } catch (cause) { if (currentEpoch(generation) && !request.signal.aborted) setError(requestFailure(cause)); }
        finally {
            requests.current.delete(request);
            if (currentEpoch(generation)) {
                activeStream.current = null;
                // A fresh signal is essential: Stop aborts the inference transport, not this read.
                await loadConversation(id, generation, true, true);
                if (currentEpoch(generation)) { setBusy(false); void loadList(generation); }
            }
        }
    }
    async function confirmAction() {
        const action = confirmation;
        if (!action || activeMutation.current || mutating || busy || !alive.current) return;
        const generation = epoch.current, request = controller(); activeMutation.current = request; listVersion.current++; setMutating(true); setError('');
        try {
            if (action.kind === 'import') {
                const source = local.find(item => item.id === action.id);
                if (!source) return;
                const imported = await history.importConversation({ id: source.id, model: source.model, turns: source.turns.map((turn, index) => ({
                    id: turn.usage?.requestId || uuidv5(JSON.stringify([source.id, index]), IMPORT_NAMESPACE), user: turn.user, assistant: turn.assistant,
                    // A historical local stream is only an explicitly imported partial record.
                    status: turn.status === 'streaming' ? 'cancelled' : turn.status, ...(turn.usage ? { usage: turn.usage } : {}),
                })) }, request.signal);
                if (!currentEpoch(generation)) return;
                choose({ kind: 'cloud', id: imported.id }); setCurrent(imported); setMissingConversation(null); updateSummary(imported); setModel(imported.model); setDetailError('');
            } else {
                await history.remove(action.id, request.signal);
                if (!currentEpoch(generation)) return;
                setConversations(items => items.filter(item => item.id !== action.id));
                if (selectionRef.current?.kind === 'cloud' && selectionRef.current.id === action.id) { choose(null); setCurrent(null); resetComposer(); }
            }
            if (currentEpoch(generation)) setConfirmation(null);
        } catch (cause) {
            if (currentEpoch(generation) && !request.signal.aborted) setError(cause instanceof WorkMockError && cause.kind === 'request_conflict' ? t('historyConflict') : t(action.kind === 'import' ? 'importError' : 'deleteError'));
        } finally { requests.current.delete(request); if (activeMutation.current === request) activeMutation.current = null; if (currentEpoch(generation)) setMutating(false); }
    }
    function logout() {
        signedOut.current = true; stop(); setEngaged(false); setConversations([]); setCurrent(null); setLocal([]); choose(null); setCatalog(null); resetComposer();
        void platform.logout().catch(() => {});
    }
    const disabled = !engaged || !validModel || loading || busy || mutating || historyLoading || selection?.kind === 'local' || serverStreaming || !!missingConversation || (selection?.kind === 'cloud' && !current);
    const link = (label: string, action: () => void, disable = false) => <Pressable accessibilityRole="button" disabled={disable} onPress={action} style={{ padding: 10 }}><Text style={{ color: theme.colors.text }}>{label}</Text></Pressable>;
    usePlatformNavigationRegistration({ items: conversations, selectedId: selection?.kind === 'cloud' ? selection.id : undefined, busy: busy || mutating, loading: loading || historyLoading });
    const lastTurn = shown?.turns.at(-1);
    const input = <View>
      {lastTurn && lastTurn.status !== 'complete' ? <Text style={{ color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 12 }}>{t(lastTurn.status === 'streaming' ? 'streaming' : lastTurn.status === 'cancelled' ? 'cancelled' : 'failed')}</Text> : null}
      {lastTurn?.usage ? <Text style={{ color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 12 }}>{lastTurn.usage.model} · {t('inputTokens')}: {lastTurn.usage.inputTokens} · {t('outputTokens')}: {lastTurn.usage.outputTokens}</Text> : null}
      <AgentInput key={scope} ref={composer} initialValue={draft} placeholder={t('placeholder')} onChangeText={setDraft} onSend={() => { void send(); }}
        availableModels={(catalog?.models || []).map(item => ({ key: item.id, name: item.name, description: null }))}
        modelMode={validModel ? { key: model, name: catalog!.models.find(item => item.id === model)!.name, description: null } : null}
        onModelModeChange={option => { if (!busy && !mutating && selectedModelAllowed(catalog, option.key)) setModel(option.key); }}
        autocompletePrefixes={[]} autocompleteSuggestions={async () => []} isSendDisabled={disabled || !draft.trim()} blockSend={disabled}
        isSending={busy} showAbortButton={busy && !!activeStream.current} onAbort={() => activeStream.current?.abort()} showStatusDetails={false} modelPickerOnly zenMode /></View>;
    const icon = (label: string, name: 'refresh-outline' | 'settings-outline' | 'log-out-outline', action: () => void, disable = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disable} onPress={action} style={{ padding: 12 }}><Ionicons name={name} size={22} color={theme.colors.textSecondary} /></Pressable>;
    return <PlatformConversationShell title={shown?.turns[0]?.user || t('newChat')} composer={input} actions={<>
        {icon(t('reloadHistory'), 'refresh-outline', () => { setError(''); setReload(value => value + 1); }, busy || mutating)}
        {icon(t('settings'), 'settings-outline', () => router.push('/settings'))}
        {icon(t('signOutWork'), 'log-out-outline', logout)}
        {selection?.kind === 'cloud' && current && !missingConversation ? <Pressable accessibilityRole="button" accessibilityLabel={t('deleteConversation')} disabled={busy || mutating || serverStreaming} onPress={() => setConfirmation({ kind: 'delete', id: current.id })} style={{ padding: 12 }}><Ionicons name="trash-outline" size={22} color={theme.colors.textSecondary} /></Pressable> : null}
    </>} newLabel={t('newChat')} historyLabel={t('history')} onNew={newConversation} busy={busy || mutating}>
      <View style={{ flex: 1, minHeight: 0 }}>
        {local.length ? <ScrollView style={{ maxHeight: 150 }}><Text style={{ padding: 8, color: theme.colors.textSecondary }}>{t('localHistory')}</Text>
            {local.map(item => <Item key={item.id} title={item.turns[0]?.user || t('newChat')} disabled={busy || mutating} showChevron={false} onPress={() => { if (busy || mutating) return; detailVersion.current++; choose({ kind: 'local', id: item.id }); setCurrent(null); setHistoryLoading(false); setModel(item.model); setError(''); resetComposer(); }} />)}
        </ScrollView> : null}
        {localCurrent ? <View><Text style={{ color: theme.colors.textSecondary }}>{t('localOnly')}</Text>{link(t('importConversation'), () => setConfirmation({ kind: 'import', id: localCurrent.id }), mutating)}</View> : null}
        {confirmation ? <View accessibilityRole="alert" style={{ padding: 12, gap: 8 }}>
            <Text style={{ color: theme.colors.text }}>{t(confirmation.kind === 'import' ? 'importConfirm' : 'deleteConfirm')}</Text>
            <Text selectable style={{ color: theme.colors.textSecondary }}>{server} · {session.authority} · {session.subject}</Text>
            {link(t(confirmation.kind === 'import' ? 'confirmImport' : 'confirmDelete'), () => { void confirmAction(); }, mutating)}
            {link(t('dismiss'), () => setConfirmation(null), mutating)}
        </View> : null}
        {loading ? <Text style={{ color: theme.colors.textSecondary }}>{t('loading')}</Text> : null}
        {!chatDisabled && historyLoading ? <Text style={{ color: theme.colors.textSecondary }}>{t('historyLoading')}</Text> : null}
        {!loading && catalog && !catalog.models.length ? <Text style={{ color: theme.colors.textSecondary }}>{t('empty')}</Text> : null}
        {[error, catalogError, ...(!chatDisabled ? [historyError, detailError, localError] : [])].filter(Boolean).map((message, index) => <Text key={index} accessibilityRole="alert" style={{ color: theme.colors.text }}>{message}</Text>)}
        {!chatDisabled && !loading && !validModel && model ? <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{t('unavailable')}</Text> : null}
        {!chatDisabled && serverStreaming && !busy ? <Text style={{ color: theme.colors.textSecondary }}>{t('serverStreaming')}</Text> : null}
        {!!missingConversation ? <Text style={{ color: theme.colors.textSecondary }}>{t('unsaved')}</Text> : null}
        <PlatformChatContent conversationId={shown?.id || 'new'} turns={shown?.turns || []} onSendMessage={text => send(text)} streaming={busy || serverStreaming} />
      </View>
    </PlatformConversationShell>;
}
