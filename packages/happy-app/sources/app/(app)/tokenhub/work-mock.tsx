import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { tokenHubFetch } from '@/integrations/tokenhub/transport';
import {
    createWorkMockClient, WorkMockError, WORK_MOCK_MAX_PROMPT_LENGTH,
    type WorkMockModel, type WorkMockUsage,
} from '@/integrations/tokenhub/workMockClient';

type Phase = 'idle' | 'streaming' | 'complete' | 'cancelled' | 'failed';
function errorMessage(error: unknown): string {
    if (!(error instanceof WorkMockError)) return '请求未完成，请重试。';
    switch (error.kind) {
        case 'authentication': return '请先登录 Work，再重新打开实验页。';
        case 'forbidden': return '当前登录未获 Work 访问权限，请检查登录状态。';
        case 'unavailable': return '此服务器未启用 Mock 网关，或服务暂不可用（503）。';
        case 'rate_limit': return '请求过于频繁，请稍后重试。';
        case 'configuration': return '服务器配置不可用。此实验仅支持 HTTPS 或本机 HTTP 服务。';
        case 'timeout': return '请求超过 30 秒，已停止。请重试。';
        case 'aborted': return '已取消。';
        case 'upstream': return '模拟上游错误已返回。这是测试错误，不产生费用。';
        case 'truncated_stream': return '连接提前结束，未收到完成标记，不能视为成功。';
        case 'invalid_response': return '服务器响应不符合 Mock 协议，已停止。';
        case 'response_limit': return '响应超过实验页的安全大小限制，已停止。';
        case 'invalid_request': return '请选择模拟模型，并输入 1–4,000 字符的提示词。';
        default: return '请求失败，请检查所选 Work 服务器后重试。';
    }
}

/** Deliberately not wired into the normal provider/model selector or session composer. */
export default function TokenHubWorkMock() {
    const auth = useAuth();
    const router = useRouter();
    const token = auth.credentials?.token;
    const [reload, setReload] = React.useState(0);
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
        setModels([]); setSelectedModel(''); setOutput(''); setChunkCount(0); setUsage(null); setPhase('idle');
        setError(clientState.error);
        if (token && clientState.client) {
            setLoadingModels(true);
            void clientState.client.listModels(controller.signal).then(catalog => {
                if (!controller.signal.aborted) { setModels(catalog); setSelectedModel(catalog[0].id); }
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
        if (activeStream.current || !clientState.client || !token || !selectedModel || !prompt.trim() || loadingModels) return;
        const controller = new AbortController();
        activeStream.current = controller;
        setOutput(''); setChunkCount(0); setUsage(null); setError(null); setPhase('streaming');
        try {
            const result = await clientState.client.stream({ model: selectedModel, prompt }, text => {
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
                setError(errorMessage(cause)); setPhase('failed'); setUsage(null);
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
    const canStart = !!token && !!clientState.client && !!selectedModel && !!prompt.trim() && !loadingModels && !busy;
    const phaseLabel = { idle: '尚未开始', streaming: '正在接收流式内容…', complete: '已收到完成标记', cancelled: '已取消，保留已收到的部分内容', failed: '请求失败，以下内容可能不完整' }[phase];

    return <>
        <Stack.Screen options={{ title: 'TokenHub · Mock 实验' }} />
        <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.banner}>
                <Text style={styles.badge}>MOCK ONLY · 不计费 · 跨端实验</Text>
                <Text accessibilityRole="header" style={styles.heading}>Work 模拟网关</Text>
                <Text style={styles.body}>仅测试模型选择、流式响应和取消。不会调用真实模型，不会扣余额，也不会更改现有会话或模型配置。</Text>
                <Text style={styles.note}>使用当前 Work 登录与已选择的服务器。提示词会发送给该服务器，请勿输入密码或其他敏感内容。</Text>
            </View>
            {!token ?
                <View style={styles.card}><Text style={styles.body}>请先登录 Work，然后返回此实验页。</Text><Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.button}><Text style={styles.buttonText}>返回登录</Text></Pressable></View> : <>
                    <View style={styles.card}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>1. 选择模拟模型</Text>
                        <Text style={styles.note}>这些测试选项不是可计费模型，也不代表 Claude Code / Codex 的兼容性。</Text>
                        {loadingModels && <Text accessibilityLiveRegion="polite" style={styles.body}>正在读取模拟模型…</Text>}
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
                        <TextInput accessibilityLabel="模拟提示词" style={styles.input} multiline editable={!busy} value={prompt}
                            onChangeText={setPrompt} maxLength={WORK_MOCK_MAX_PROMPT_LENGTH} placeholder="输入测试提示词" placeholderTextColor="#64748b" textAlignVertical="top" />
                        <Text style={styles.note}>{prompt.length} / {WORK_MOCK_MAX_PROMPT_LENGTH} 字符 · 仅发送所选模型和提示词</Text>
                        <View style={styles.row}>
                            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canStart }} disabled={!canStart}
                                onPress={() => { void start(); }} style={[styles.button, !canStart && styles.disabled]}><Text style={styles.buttonText}>开始模拟</Text></Pressable>
                            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !busy }} disabled={!busy}
                                onPress={cancel} style={[styles.secondaryButton, !busy && styles.disabled]}><Text style={styles.secondaryText}>取消请求</Text></Pressable>
                        </View>
                    </View>
                </>}
            {error && <View accessibilityRole="alert" style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>}
            <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>3. 流式输出</Text>
                <Text accessibilityLiveRegion="polite" style={styles.body}>{phaseLabel} · 已收到 {chunkCount} 个片段</Text>
                <View style={styles.output}><Text selectable style={styles.outputText}>{output || '模拟输出会逐段显示在这里。'}</Text></View>
                {usage ? <View style={styles.usage}>
                    <Text style={styles.sectionTitle}>模拟用量 · 不计费</Text>
                    <Text style={styles.body}>输入 {usage.inputTokens} tokens · 输出 {usage.outputTokens} tokens</Text>
                    <Text style={styles.note}>模型：{usage.model}</Text><Text selectable style={styles.note}>请求：{usage.requestId}</Text>
                    <Text style={styles.note}>仅为服务器生成的测试统计，不是账单、余额扣减或真实模型用量。</Text>
                </View> : <Text style={styles.note}>只有完整结束的模拟请求才显示统计。取消或失败不代表完成，不产生费用。</Text>}
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
