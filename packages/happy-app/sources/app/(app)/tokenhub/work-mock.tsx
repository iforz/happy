import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { tokenHubFetch } from '@/integrations/tokenhub/transport';
import {
    createWorkMockClient, WorkMockError, WORK_MOCK_MAX_PROMPT_LENGTH,
    type WorkMockModel, type WorkMockUsage, type WorkModelCatalog,
} from '@/integrations/tokenhub/workMockClient';

type Phase = 'idle' | 'streaming' | 'complete' | 'cancelled' | 'failed';
function errorMessage(error: unknown, real = false): string {
    if (!(error instanceof WorkMockError)) return real ? '请求未完成，费用状态不确定。请先核对 Core 记录。' : '请求未完成，请重试。';
    switch (error.kind) {
        case 'authentication': return '请先登录 Work，再重新打开实验页。';
        case 'forbidden': return '当前请求没有模型访问权限或可用配额，请检查 Work 授权与配额。';
        case 'quota_exceeded': return '可用配额不足，未自动重试。请检查 Core 配额与记录。';
        case 'unavailable': return '此服务器未启用 Work 网关，或服务暂不可用（503）。';
        case 'rate_limit': return '请求过于频繁，请稍后重试。';
        case 'configuration': return '服务器配置不可用。此实验仅支持 HTTPS 或本机 HTTP 服务。';
        case 'timeout': return real ? '请求超时，已停止接收。费用状态不确定，请先核对 Core 记录。' : '请求超过 30 秒，已停止。请重试。';
        case 'aborted': return '已取消。';
        case 'upstream': return real ? '上游请求未完成。费用请以 Core 记录为准。' : '模拟上游错误已返回。这是测试错误，不产生费用。';
        case 'work_reconciliation_required': return 'Core 结算尚未确定，待核对。请勿再次发起此请求；先核对 Core 记录。';
        case 'usage_unavailable': return '未收到可靠用量，费用状态不确定。请核对 Core 记录。';
        case 'request_conflict': return '请求标识已使用，未自动重试。请先核对 Core 记录。';
        case 'core_gateway_error': return 'Core 网关未完成请求。请核对 Core 记录。';
        case 'truncated_stream': return '连接提前结束，未收到完成标记，不能视为成功。';
        case 'invalid_response': return '服务器响应不符合 Work 协议，已停止。';
        case 'response_limit': return '响应超过实验页的安全大小限制，已停止。';
        case 'invalid_request': return '请选择模型，并输入 1–4,000 字符的提示词。';
        default: return real ? '请求失败，费用状态不确定。请检查所选 Work 服务器并核对 Core 记录。' : '请求失败，请检查所选 Work 服务器后重试。';
    }
}

/** Deliberately not wired into the normal provider/model selector or session composer. */
export default function TokenHubWorkMock() {
    const auth = useAuth();
    const router = useRouter();
    const token = auth.credentials?.token;
    const [reload, setReload] = React.useState(0);
    const [catalog, setCatalog] = React.useState<WorkModelCatalog | null>(null);
    const real = catalog?.mode === 'real';
    const mock = catalog?.mode === 'mock';
    const [reconciliationRequired, setReconciliationRequired] = React.useState(false);
    const [requestId, setRequestId] = React.useState<string | null>(null);
    const [models, setModels] = React.useState<WorkMockModel[]>([]);
    const [selectedModel, setSelectedModel] = React.useState('');
    const [prompt, setPrompt] = React.useState('你好，测试模拟流式响应。');
    const [loadingModels, setLoadingModels] = React.useState(false);
    const [phase, setPhase] = React.useState<Phase>('idle');
    const [output, setOutput] = React.useState('');
    const [chunkCount, setChunkCount] = React.useState(0);
    const [usage, setUsage] = React.useState<WorkMockUsage | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const activeStream = React.useRef<AbortController | null>(null);
    const clientState = React.useMemo(() => {
        try {
            return { client: createWorkMockClient({ baseUrl: getServerUrl(), tokenProvider: async () => token ?? null, fetch: tokenHubFetch }), error: null };
        } catch (cause) { return { client: null, error: errorMessage(cause) }; }
    }, [token, reload]);

    useFocusEffect(React.useCallback(() => {
        const controller = new AbortController();
        setCatalog(null); setRequestId(null); setModels([]); setSelectedModel(''); setOutput(''); setChunkCount(0); setUsage(null); setPhase('idle');
        setError(clientState.error);
        if (token && clientState.client) {
            setLoadingModels(true);
            void clientState.client.getCatalog(controller.signal).then(catalog => {
                if (!controller.signal.aborted) { setCatalog(catalog); setModels(catalog.models); setSelectedModel(catalog.models[0]?.id ?? ''); }
            }).catch(cause => {
                if (!controller.signal.aborted) setError(errorMessage(cause));
            }).finally(() => { if (!controller.signal.aborted) setLoadingModels(false); });
        } else setLoadingModels(false);
        return () => {
            controller.abort();
            activeStream.current?.abort();
            activeStream.current = null;
        };
    }, [clientState, token]));

    async function start() {
        // Ref guard prevents double-clicks before React commits the streaming state.
        if (reconciliationRequired || activeStream.current || !clientState.client || !token || !selectedModel || !prompt.trim() || loadingModels) return;
        const controller = new AbortController();
        activeStream.current = controller;
        setOutput(''); setChunkCount(0); setUsage(null); setError(null); setPhase('streaming');
        try {
            // A fresh ID belongs to this explicit action only; there is no automatic retry.
            const id = real ? randomUUID() : undefined;
            setRequestId(id ?? null);
            const result = await clientState.client.stream({ model: selectedModel, prompt, ...(id ? { requestId: id } : {}) }, text => {
                if (activeStream.current === controller && !controller.signal.aborted) {
                    setOutput(previous => previous + text);
                    setChunkCount(previous => previous + 1);
                }
            }, controller.signal);
            if (activeStream.current === controller && !controller.signal.aborted) {
                setUsage(result); setPhase('complete');
            }
        } catch (cause) {
            if (activeStream.current === controller && !controller.signal.aborted) {
                if (cause instanceof WorkMockError && cause.kind === 'work_reconciliation_required') setReconciliationRequired(true);
                setError(errorMessage(cause, real)); setPhase('failed'); setUsage(null);
            }
        } finally {
            if (activeStream.current === controller) activeStream.current = null;
        }
    }
    function cancel() {
        activeStream.current?.abort();
        activeStream.current = null;
        setPhase('cancelled'); setUsage(null); setError(null);
    }
    const busy = phase === 'streaming';
    const canStart = !!token && !!clientState.client && !!selectedModel && !!prompt.trim() && !loadingModels && !busy && !reconciliationRequired;
    const phaseLabel = { idle: '尚未开始', streaming: '正在接收流式内容…', complete: '已收到完成标记', cancelled: '已取消，保留已收到的部分内容', failed: '请求失败，以下内容可能不完整' }[phase];

    return <>
        <Stack.Screen options={{ title: 'TokenHub · Work 网关' }} />
        <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.banner}>
                <Text style={styles.badge}>{real ? 'REAL · 可计费 · Core 结算' : mock ? 'MOCK ONLY · 不计费 · 跨端实验' : '正在确认网关模式'}</Text>
                <Text accessibilityRole="header" style={styles.heading}>{real ? 'Work 真实模型网关' : mock ? 'Work 模拟网关' : 'Work 模型网关'}</Text>
                <Text style={styles.body}>{real ? '发送请求会调用真实模型并可能产生费用。Core 是用量、扣费和结算的唯一权威；本页不改变现有会话或模型配置。' : mock ? '仅测试模型选择、流式响应和取消。不会调用真实模型，不会扣余额，也不会更改现有会话或模型配置。' : '读取服务器模式后才能发送请求；确认模式前不作费用保证。'}</Text>
                <Text style={styles.note}>使用当前 Work 登录与已选择的服务器。提示词会发送给该服务器，请勿输入密码或其他敏感内容。</Text>
            </View>
            {!token ?
                <View style={styles.card}><Text style={styles.body}>请先登录 Work，然后返回此实验页。</Text><Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.button}><Text style={styles.buttonText}>返回登录</Text></Pressable></View> : <>
                    <View style={styles.card}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>{mock ? '1. 选择模拟模型' : '1. 选择模型'}</Text>
                        <Text style={styles.note}>{real ? '以下为服务器允许的可计费模型；不自动重试。再次点击发送会创建新请求，可能再次计费。' : mock ? '这些测试选项不是可计费模型，也不代表 Claude Code / Codex 的兼容性。' : '等待服务器返回模型与计费模式。'}</Text>
                        {loadingModels && <Text accessibilityLiveRegion="polite" style={styles.body}>正在读取模型…</Text>}
                        {catalog && !models.length && <Text style={styles.note}>当前没有可用模型，请检查 Core 授权与配额后重新加载。</Text>}
                        <View style={styles.row}>
                            {models.map(model => <Pressable key={model.id} accessibilityRole="radio" accessibilityLabel={model.name}
                                accessibilityState={{ checked: selectedModel === model.id, disabled: busy }} disabled={busy}
                                onPress={() => setSelectedModel(model.id)} style={[styles.model, selectedModel === model.id && styles.selectedModel, busy && styles.disabled]}>
                                <Text style={styles.body}>{model.name}</Text><Text style={styles.note}>{model.id}</Text>
                            </Pressable>)}
                        </View>
                        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || loadingModels }} disabled={busy || loadingModels}
                            onPress={() => setReload(value => value + 1)} style={[styles.secondaryButton, (busy || loadingModels) && styles.disabled]}>
                            <Text style={styles.secondaryText}>重新加载模型</Text>
                        </Pressable>
                    </View>
                    <View style={styles.card}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>2. 发送测试提示词</Text>
                        <TextInput accessibilityLabel={mock ? '模拟提示词' : '提示词'} style={styles.input} multiline editable={!busy} value={prompt}
                            onChangeText={setPrompt} maxLength={WORK_MOCK_MAX_PROMPT_LENGTH} placeholder="输入测试提示词" placeholderTextColor="#64748b" textAlignVertical="top" />
                        <Text style={styles.note}>{prompt.length} / {WORK_MOCK_MAX_PROMPT_LENGTH} 字符 · {real ? '仅发送模型、提示词及请求 UUID' : '仅发送所选模型和提示词'}</Text>
                        <View style={styles.row}>
                            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canStart }} disabled={!canStart}
                                onPress={() => { void start(); }} style={[styles.button, !canStart && styles.disabled]}><Text style={styles.buttonText}>{real ? '发送真实请求（可能计费）' : '开始模拟'}</Text></Pressable>
                            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !busy }} disabled={!busy}
                                onPress={cancel} style={[styles.secondaryButton, !busy && styles.disabled]}><Text style={styles.secondaryText}>取消请求</Text></Pressable>
                        </View>
                    </View>
                </>}
            {reconciliationRequired && <Text accessibilityRole="alert" style={styles.errorText}>Core 结算待核对，已暂停发送。请先核对 Core 记录，不要重复发起请求。</Text>}
            {real && requestId && <Text selectable style={styles.note}>本次请求：{requestId}</Text>}
            {error && <View accessibilityRole="alert" style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>}
            <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>3. 流式输出</Text>
                <Text accessibilityLiveRegion="polite" style={styles.body}>{phaseLabel} · 已收到 {chunkCount} 个片段</Text>
                <View style={styles.output}><Text selectable style={styles.outputText}>{output || '输出会逐段显示在这里。'}</Text></View>
                {usage ? <View style={styles.usage}>
                    <Text style={styles.sectionTitle}>{usage.billable ? '模型用量 · 非结算凭证' : '模拟用量 · 不计费'}</Text>
                    <Text style={styles.body}>输入 {usage.inputTokens} tokens · 输出 {usage.outputTokens} tokens</Text>
                    <Text style={styles.note}>模型：{usage.model}</Text><Text selectable style={styles.note}>请求：{usage.requestId}</Text>
                    {usage.coreRequestId && <Text selectable style={styles.note}>Core 记录：{usage.coreRequestId}</Text>}
                    <Text style={styles.note}>{usage.billable ? '以上仅显示模型返回的 token 数量，不证明扣费成功或结算完成。费用以 Core 权威记录为准。' : '仅为服务器生成的测试统计，不是账单、余额扣减或真实模型用量。'}</Text>
                </View> : <Text style={styles.note}>{real ? '中断、取消、失败或缺失用量时，费用状态不确定，不代表免费。请核对 Core 记录；本页不会自动重试。' : mock ? '只有完整结束的模拟请求才显示统计。取消或失败不代表完成，不产生费用。' : '用量与计费说明将在确认服务器模式后显示。'}</Text>}
            </View>
        </ScrollView>
    </>;
}

const styles = StyleSheet.create({
    page: { flex: 1, backgroundColor: '#f1f5f9' },
    content: { padding: 24, gap: 18, width: '100%', maxWidth: 900, alignSelf: 'center' },
    banner: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc', borderWidth: 1, borderRadius: 16, padding: 22, gap: 12 },
    badge: { color: '#075985', fontSize: 13, fontWeight: '800', letterSpacing: 1 },
    heading: { color: '#0f172a', fontSize: 28, fontWeight: '700' },
    body: { color: '#1e293b', fontSize: 15, lineHeight: 23 },
    note: { color: '#475569', fontSize: 13, lineHeight: 20 },
    card: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 16, padding: 20, gap: 12 },
    sectionTitle: { color: '#0f172a', fontSize: 17, fontWeight: '700' },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    model: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, gap: 4 },
    selectedModel: { borderColor: '#0369a1', backgroundColor: '#e0f2fe' },
    input: { color: '#0f172a', backgroundColor: '#f8fafc', borderColor: '#94a3b8', borderWidth: 1, borderRadius: 10, padding: 14, minHeight: 120, fontSize: 15 },
    button: { alignSelf: 'flex-start', backgroundColor: '#0369a1', borderRadius: 9, paddingVertical: 12, paddingHorizontal: 20 },
    buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
    secondaryButton: { alignSelf: 'flex-start', borderColor: '#64748b', borderWidth: 1, borderRadius: 9, paddingVertical: 11, paddingHorizontal: 18 },
    secondaryText: { color: '#334155', fontSize: 15, fontWeight: '600' },
    disabled: { opacity: 0.45 },
    errorBox: { backgroundColor: '#fef2f2', borderColor: '#fca5a5', borderWidth: 1, borderRadius: 12, padding: 16 },
    errorText: { color: '#991b1b', fontSize: 15, lineHeight: 23 },
    output: { backgroundColor: '#0f172a', borderRadius: 10, padding: 16, minHeight: 140 },
    outputText: { color: '#f8fafc', fontSize: 14, lineHeight: 23, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
    usage: { borderColor: '#86efac', backgroundColor: '#f0fdf4', borderWidth: 1, borderRadius: 10, padding: 16, gap: 6 },
});
