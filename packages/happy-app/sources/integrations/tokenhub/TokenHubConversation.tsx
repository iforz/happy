import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { MMKV } from 'react-native-mmkv';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { AgentInput } from '@/components/AgentInput';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { encryptSecretBox, decryptSecretBox } from '@/encryption/libsodium';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { tokenHubFetch } from './transport';
import { createWorkMockClient, WorkMockError, type WorkModelCatalog } from './workMockClient';
import { conversationInput, requireRealCatalog, selectedModelAllowed, type Conversation, type Turn } from './conversation';
import { workText as t } from './workText';
import { platformAccountScope, type PlatformSession } from './platformSession';
import { PlatformAccountConversation } from './PlatformAccountConversation';

const storage = new MMKV({id:'tokenhub-conversations-v1'});
export function accountScope(server: string, token: string): string {
    try {
        const payload = JSON.parse(new TextDecoder().decode(decodeBase64(token.split('.')[1], 'base64url')));
        if (typeof payload.sub !== 'string' || !payload.sub) throw new Error();
        return JSON.stringify([server, payload.iss, payload.sub]);
    } catch { return JSON.stringify([server, 'unavailable']); }
}
function failure(error: unknown): string {
    if (!(error instanceof WorkMockError)) return t('requestError');
    if (error.kind === 'authentication') return t('authentication');
    if (error.kind === 'forbidden') return t('forbidden');
    if (error.kind === 'quota_exceeded') return t('quota');
    if (error.kind === 'rate_limit') return t('rateLimit');
    if (error.kind === 'invalid_request') return t('contextLimit');
    if (['work_reconciliation_required','usage_unavailable','truncated_stream','timeout','network'].includes(error.kind)) return t('reconciliation');
    return t('requestError');
}

/** A new-chat intent resets the one Home owner, never a second stacked writer. */
export function TokenHubHomeConversation() {
    const auth = useAuth();
    const { newChat } = useLocalSearchParams<{ newChat?: string }>();
    const intent = typeof newChat === 'string' ? newChat : '';
    const scope = accountScope(getServerUrl(), auth.credentials?.token || '');
    return <TokenHubConversation key={JSON.stringify([scope, intent])} startNew={!!intent} />;
}

export function PlatformHomeConversation({ session }: { session: PlatformSession }) {
    const { newChat, conversationId } = useLocalSearchParams<{ newChat?: string; conversationId?: string }>();
    const intent = typeof newChat === 'string' ? newChat : '';
    const initialConversationId = !intent && typeof conversationId === 'string' ? conversationId : undefined;
    return <TokenHubConversation key={JSON.stringify([platformAccountScope(session), session.sessionId, session.csrf, intent, initialConversationId])} startNew={!!intent} initialConversationId={initialConversationId} platformSession={session} />;
}

/** The normal TokenHub conversation surface. Machine RPC is deliberately not used. */
export function TokenHubConversation({ startNew = false, platformSession, initialConversationId }: { startNew?: boolean; platformSession?: PlatformSession; initialConversationId?: string } = {}) {
    if (platformSession) return <PlatformAccountConversation key={JSON.stringify([platformAccountScope(platformSession), platformSession.sessionId, platformSession.csrf, initialConversationId])} session={platformSession} startNew={startNew} initialConversationId={initialConversationId} />;
    return <LocalTokenHubConversation startNew={startNew} />;
}

function LocalTokenHubConversation({ startNew = false }: { startNew?: boolean } = {}) {
    const auth = useAuth(), router = useRouter(), {theme} = useUnistyles();
    const server = getServerUrl(), token = auth.credentials?.token || '';
    const scope = accountScope(server, token), secret = auth.credentials?.secret || '';
    const composer = React.useRef<MultiTextInputHandle>(null);
    const active = React.useRef<AbortController | null>(null), generation = React.useRef(0);
    const visibleHistory = React.useRef<Conversation[]>([]);
    const [catalog, setCatalog] = React.useState<WorkModelCatalog | null>(null);
    const [conversations, setConversations] = React.useState<Conversation[]>([]);
    const [selected, setSelected] = React.useState(''), [model, setModel] = React.useState('');
    const [loading, setLoading] = React.useState(true), [busy, setBusy] = React.useState(false), [draft, setDraft] = React.useState('');
    const [error, setError] = React.useState(''), [storageError, setStorageError] = React.useState('');
    const [reload, setReload] = React.useState(0), [blocked, setBlocked] = React.useState(false);
    const focused = React.useRef(false);
    const historyWritable = React.useRef(true);
    const activation = React.useRef({ initialized: false, scope: '', selected: '', model: '', blocked: false, error: '' });
    Object.assign(activation.current, { selected, model, blocked, error });
    const client = React.useMemo(() => createWorkMockClient({baseUrl:server, requireRealCatalog:true, tokenProvider:async()=>token || null, fetch:tokenHubFetch}), [server,token,reload]);
    const current = conversations.find(item=>item.id===selected);
    const validModel = selectedModelAllowed(catalog, model);
    function persist(value: Conversation[]) {
        visibleHistory.current=value;
        setConversations(value);
        try { if (!secret || !historyWritable.current) throw new Error(); storage.set(scope, encodeBase64(encryptSecretBox(value, decodeBase64(secret,'base64url')), 'base64')); }
        catch { setStorageError(t('savedError')); }
    }
    // Navigator blur releases ownership. Retained screens must not write stale history.
    useFocusEffect(React.useCallback(() => {
        const previous = { ...activation.current };
        const resume = previous.initialized && previous.scope === scope;
        activation.current.initialized = true; activation.current.scope = scope;
        focused.current = true;
        const epoch = ++generation.current, controller = new AbortController();
        active.current?.abort(); active.current=null;
        setCatalog(null);setModel('');setBusy(false);setLoading(true);
        if (!resume) setDraft('');
        setError(resume ? previous.error : '');setBlocked(resume && previous.blocked);
        let restored: Conversation[]=[];
        historyWritable.current = !!secret;
        try {
            const stored=secret ? storage.getString(scope) : undefined;
            const decoded=stored ? decryptSecretBox(decodeBase64(stored,'base64'),decodeBase64(secret,'base64url')) : [];
            // Unsupported/corrupt data stays intact. Filtering it into an empty list
            // would permanently replace ciphertext on the next blur or send.
            if (!Array.isArray(decoded) || decoded.length > 100 || !decoded.every(item =>
                typeof item?.id === 'string' && !!item.id && typeof item?.model === 'string' && !!item.model && Array.isArray(item.turns)
                && item.turns.every((turn: Turn) => typeof turn?.user === 'string' && typeof turn?.assistant === 'string'
                    && ['streaming', 'complete', 'cancelled', 'failed'].includes(turn.status)))) throw new Error('Unreadable encrypted history');
            restored=decoded;
        } catch { historyWritable.current=false; setStorageError(t('savedError')); }
        const interrupted=restored.some(item=>item.turns.some(turn=>turn.status==='streaming'));
        restored=restored.map(item=>({...item,turns:item.turns.map(turn=>turn.status==='streaming'?{...turn,status:'failed' as const}:turn)}));
        const restoredSelection = resume ? (restored.some(item => item.id === previous.selected) ? previous.selected : '')
            : startNew ? '' : restored[0]?.id || '';
        const restoredModel = resume ? previous.model || restored.find(item => item.id === restoredSelection)?.model || ''
            : (startNew ? '' : restored[0]?.model) || '';
        visibleHistory.current=restored;setConversations(restored);setSelected(restoredSelection);
        if(interrupted){setBlocked(true);setError(t('reconciliation'));}
        void client.getCatalog(controller.signal).then(value=>{
            requireRealCatalog(value);
            if(epoch!==generation.current)return;
            setCatalog(value);setModel(restoredModel || value.models[0]?.id || '');
        }).catch(()=>{if(epoch===generation.current&&!controller.signal.aborted){setCatalog(null);setModel('');setError(t('catalogError'));}})
          .finally(()=>{if(epoch===generation.current)setLoading(false);});
        return ()=>{
            focused.current=false;
            try { if (secret && historyWritable.current) storage.set(scope,encodeBase64(encryptSecretBox(visibleHistory.current,decodeBase64(secret,'base64url')),'base64')); } catch {}
            generation.current++;controller.abort();active.current?.abort();active.current=null;
        };
    },[client,scope,secret,startNew]));
    function update(id:string, turn:Turn) {
        const next=visibleHistory.current.map(item=>item.id===id?{...item,turns:[...item.turns.slice(0,-1),turn]}:item);visibleHistory.current=next;setConversations(next);
    }
    async function send() {
        if(!focused.current || busy || loading || blocked || !validModel)return;
        const question=composer.current?.getText().trim() || '';
        if(!question)return;
        const history=current?.turns || [];
        let messages;try{messages=conversationInput(history,question);}catch{setError(t('contextLimit'));return;}
        const id=current?.id || randomUUID(), requestId=randomUUID(), epoch=generation.current;
        const controller=new AbortController();active.current=controller;setBusy(true);setError('');
        const turn:Turn={user:question,assistant:'',status:'streaming'};
        const base:Conversation=current?{...current,model,turns:[...history,turn]}:{id,model,turns:[turn]};
        const before=conversations.filter(item=>item.id!==id);
        setSelected(id);persist([base,...before]);
        composer.current?.setTextAndSelection('',{start:0,end:0});setDraft('');
        try{
            turn.usage=await client.stream({model,messages,requestId},text=>{
                if(epoch!==generation.current)return;
                turn.assistant+=text;update(id,{...turn});
            },controller.signal);
            turn.status='complete';
        }catch(cause){
            turn.status=controller.signal.aborted?'cancelled':'failed';
            if(epoch===generation.current&&!controller.signal.aborted){setError(failure(cause));if(cause instanceof WorkMockError&&['work_reconciliation_required','usage_unavailable','truncated_stream','timeout','network'].includes(cause.kind))setBlocked(true);}
        }finally{
            if(epoch===generation.current){persist([{...base,turns:[...history,{...turn}]},...before]);setBusy(false);active.current=null;}
        }
    }
    const link=(label:string,action:()=>void)=><Pressable accessibilityRole="button" onPress={action} style={{padding:10}}><Text style={{color:theme.colors.text}}>{label}</Text></Pressable>;
    return <View style={{flex:1,backgroundColor:theme.colors.groupped.background,padding:16,gap:12}}>
        <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:8}}>
            <Text accessibilityRole="header" style={{fontSize:24,fontWeight:'600',color:theme.colors.text,flex:1}}>{t('title')}</Text>
            {link(t('settings'),()=>router.push('/settings'))}
        </View>
        <ScrollView horizontal style={{maxHeight:45}}>
            {link(t('newChat'),()=>{if(!busy){setSelected('');setDraft('');setError('');composer.current?.setTextAndSelection('',{start:0,end:0});}})}
            {conversations.map(item=><Pressable key={item.id} disabled={busy} onPress={()=>{setSelected(item.id);setModel(item.model);setError('');}} style={{padding:10}}><Text numberOfLines={1} style={{maxWidth:180,color:theme.colors.text}}>{item.turns[0]?.user || t('newChat')}</Text></Pressable>)}
        </ScrollView>
        {loading?<Text style={{color:theme.colors.textSecondary}}>{t('loading')}</Text>:null}
        {!loading&&catalog&&!catalog.models.length?<Text style={{color:theme.colors.textSecondary}}>{t('empty')}</Text>:null}
        {error?<Text accessibilityRole="alert" style={{color:theme.colors.text}}>{error}</Text>:null}
        {storageError?<Text accessibilityRole="alert" style={{color:theme.colors.text}}>{storageError}</Text>:null}
        {!loading&&!validModel&&model?<Text accessibilityRole="alert" style={{color:theme.colors.text}}>{t('unavailable')}</Text>:null}
        {!busy?link(t('reload'),()=>setReload(value=>value+1)):null}
        {catalog?.models.length ? <View style={{gap:6}}>
            <Text style={{color:theme.colors.textSecondary}}>{t('models')}</Text>
            <ScrollView horizontal style={{maxHeight:48}} contentContainerStyle={{gap:8}}>
                {catalog.models.map(item=><Pressable key={item.id} accessibilityRole="radio" accessibilityState={{checked:model===item.id,disabled:busy}} disabled={busy}
                    onPress={()=>{if(selectedModelAllowed(catalog,item.id))setModel(item.id);}}
                    style={{padding:10,borderWidth:1,borderRadius:8,borderColor:theme.colors.textSecondary,backgroundColor:model===item.id?theme.colors.surfacePressed:'transparent'}}>
                    <Text style={{color:theme.colors.text,fontWeight:model===item.id?'600':'400'}}>{item.name}</Text>
                </Pressable>)}
            </ScrollView>
        </View> : null}
        <ScrollView style={{flex:1}} contentContainerStyle={{gap:16,paddingVertical:12}}>
            {current?.turns.map((turn,index)=><View key={index} style={{gap:8}}>
                <Text style={{fontWeight:'600',color:theme.colors.text}}>{t('user')}</Text><Text selectable style={{color:theme.colors.text}}>{turn.user}</Text>
                <Text style={{fontWeight:'600',color:theme.colors.text}}>{t('assistant')}</Text><Text selectable style={{color:theme.colors.text}}>{turn.assistant}</Text>
                <Text style={{color:theme.colors.textSecondary}}>{t(turn.status==='streaming'?'streaming':turn.status==='complete'?'complete':turn.status==='cancelled'?'cancelled':'failed')}</Text>
                {turn.usage?<Text style={{color:theme.colors.textSecondary}}>{t('inputTokens')}: {turn.usage.inputTokens} · {t('outputTokens')}: {turn.usage.outputTokens} · {turn.usage.model}</Text>:null}
            </View>)}
        </ScrollView>
        <AgentInput key={scope} ref={composer} initialValue="" placeholder={t('placeholder')} onChangeText={setDraft}
            onSend={()=>{void send();}} availableModels={(catalog?.models || []).map(item=>({key:item.id,name:item.name,description:null}))}
            modelMode={validModel?{key:model,name:catalog!.models.find(item=>item.id===model)!.name,description:null}:null}
            onModelModeChange={option=>{if(!busy&&selectedModelAllowed(catalog,option.key))setModel(option.key);}}
            autocompletePrefixes={[]} autocompleteSuggestions={async()=>[]} isSendDisabled={!validModel||loading||busy||!draft.trim()||blocked}
            blockSend={!validModel||loading||blocked} isSending={busy} showAbortButton={busy} onAbort={()=>active.current?.abort()}
            showStatusDetails={false} />
        <Text style={{color:theme.colors.textSecondary,fontSize:12}}>{t('records')}</Text>
    </View>;
}
