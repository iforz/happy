import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import {act,create} from 'react-test-renderer';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({credentials:{token:'head.eyJzdWIiOiJmaXh0dXJlIiwiaXNzIjoiaGFuZHkifQ.sig',secret:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},server:'https://work.example',draft:'',id:0,storage:new Map<string,string>(),language:'en',mode:undefined as string|undefined,tokenHub:true,isAuthenticated:true}));
vi.mock('react-native',()=>({View:'View',Text:'Text',Pressable:'Pressable',ScrollView:'ScrollView'}));
vi.mock('react-native-unistyles',()=>({useUnistyles:()=>({theme:{colors:{text:'black',textSecondary:'gray',groupped:{background:'white'}}}})}));
vi.mock('react-native-mmkv',()=>({MMKV:class{getString(k:string){return f.storage.get(k)}set(k:string,v:string){f.storage.set(k,v)}}}));
vi.mock('expo-router',()=>({useRouter:()=>({push:vi.fn()}),useLocalSearchParams:()=>({mode:f.mode}),Redirect:'Redirect'}));
vi.mock('expo-crypto',()=>({randomUUID:()=>`00000000-0000-4000-8000-${String(++f.id).padStart(12,'0')}`}));
vi.mock('@/auth/AuthContext',()=>({useAuth:()=>({credentials:f.credentials,isAuthenticated:f.isAuthenticated})}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=>f.server}));
vi.mock('@/text',()=>({getCurrentLanguage:()=>f.language}));
vi.mock('@/encryption/libsodium',()=>({encryptSecretBox:(x:any)=>new TextEncoder().encode(JSON.stringify(x)),decryptSecretBox:(x:Uint8Array)=>JSON.parse(new TextDecoder().decode(x))}));
vi.mock('@/components/AgentInput',async()=>{const R=await import('react');return {AgentInput:R.forwardRef((props:any,ref:any)=>{R.useImperativeHandle(ref,()=>({getText:()=>f.draft,setTextAndSelection:(text:string)=>{f.draft=text}}));return R.createElement('AgentInput',props)})}});
vi.mock('./sessionSource',()=>({isTokenHubSessionForUI:()=>f.tokenHub}));
import {TokenHubConversation} from './TokenHubConversation';
import {NewSessionEntry} from './NewSessionEntry';
let renderer:ReturnType<typeof create>,fetcher:ReturnType<typeof vi.fn>;
const models=[{id:'qwen-current',name:'Qwen'},{id:'claude-authorized',name:'Claude'},{id:'default',name:'Default model'}];
const catalog=()=>new Response(JSON.stringify({mode:'real',billable:true,models}),{headers:{'content-type':'application/json'}});
function completion(init:RequestInit){const input=JSON.parse(init.body as string);return new Response([{type:'delta',text:'answer'},{type:'usage',model:input.model,requestId:input.requestId,inputTokens:5,outputTokens:2,mock:false,billable:true,accounting:'core'},{type:'done'}].map(x=>JSON.stringify(x)).join('\n')+'\n',{headers:{'content-type':'application/x-ndjson'}})}
async function render(){await act(async()=>{renderer=create(React.createElement(TokenHubConversation))})}
const composer=()=>renderer.root.findByType('AgentInput');
async function send(text:string){f.draft=text;await act(async()=>{composer().props.onChangeText(text)});await act(async()=>{composer().props.onSend();await new Promise(resolve=>setTimeout(resolve,0))})}
beforeEach(()=>{f.storage.clear();f.mode=undefined;f.tokenHub=true;f.isAuthenticated=true;f.id=0;f.draft='';f.server='https://work.example';f.language='en';f.credentials={token:'head.eyJzdWIiOiJmaXh0dXJlIiwiaXNzIjoiaGFuZHkifQ.sig',secret:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);fetcher=vi.fn(async(url:string,init:RequestInit)=>url.endsWith('/models')?catalog():completion(init));vi.stubGlobal('fetch',fetcher)});
afterEach(async()=>{if(renderer)await act(async()=>renderer.unmount());vi.unstubAllGlobals()});
it('normal composer offers exactly the real authorized catalog without a synthetic default',async()=>{await render();expect(composer().props.availableModels.map((x:any)=>x.key)).toEqual(['qwen-current','claude-authorized']);expect(composer().props.modelMode.key).toBe('qwen-current')});
it('normal sends carry the chosen model, exact complete history, unique IDs and only the Work auth token',async()=>{await render();await send('first');await send('follow up');const calls=fetcher.mock.calls.filter(([url])=>url.endsWith('/stream'));expect(calls).toHaveLength(2);const first=JSON.parse(calls[0][1].body as string),second=JSON.parse(calls[1][1].body as string);expect(second.model).toBe('qwen-current');expect(second.messages).toEqual([{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'follow up'}]);expect(second.requestId).not.toBe(first.requestId);expect(JSON.stringify(calls)).not.toContain(f.credentials.secret)});
it('empty catalog disables sending and never substitutes Claude or a saved default',async()=>{fetcher.mockResolvedValueOnce(new Response(JSON.stringify({mode:'real',billable:true,models:[]}),{headers:{'content-type':'application/json'}}));await render();expect(composer().props.availableModels).toEqual([]);await send('attempt');expect(fetcher.mock.calls.some(([url])=>url.endsWith('/stream'))).toBe(false)});
it('directory failure disables the actual send handler',async()=>{fetcher.mockResolvedValueOnce(new Response('',{status:503}));await render();expect(composer().props.blockSend).toBe(true);await send('attempt');expect(fetcher).toHaveBeenCalledTimes(1)});
it('account and server change discard old catalog, selection and conversation before loading their scope',async()=>{await render();await send('private first account');f.credentials={...f.credentials,token:'head.eyJzdWIiOiJib2IiLCJpc3MiOiJoYW5keSJ9.sig'};f.server='https://other-work.example';fetcher.mockResolvedValueOnce(new Response('',{status:503}));await act(async()=>{renderer.update(React.createElement(TokenHubConversation))});expect(composer().props.availableModels).toEqual([]);expect(composer().props.modelMode).toBeNull();expect(JSON.stringify(renderer.toJSON())).not.toContain('private first account')});
it('shows Chinese actions and errors in Chinese mode',async()=>{f.language='zh-Hans';fetcher.mockResolvedValueOnce(new Response('',{status:503}));await render();expect(JSON.stringify(renderer.toJSON())).toContain('无法读取授权模型');expect(composer().props.placeholder).toBe('向所选模型发送消息')});
it('visible catalog controls select the exact model used by the normal composer',async()=>{await render();const option=renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityRole==='radio'&&node.props.children.props.children==='Claude');expect(option).toBeDefined();await act(async()=>option!.props.onPress());await send('use chosen model');const call=fetcher.mock.calls.find(([url])=>url.endsWith('/stream'));expect(JSON.parse(call![1].body as string).model).toBe('claude-authorized')});

async function renderNewEntry() {
    await act(async()=>{renderer=create(React.createElement(NewSessionEntry, null, React.createElement('LegacyDeviceComposer')))});
}
it('/new uses the existing TokenHub gateway rather than the legacy CLI model picker',async()=>{
    fetcher.mockImplementation(async(url:string,init:RequestInit)=>url.endsWith('/models')
        ? new Response(JSON.stringify({mode:'real',billable:true,models:[{id:'glm-5',name:'GLM 5'}]}),{headers:{'content-type':'application/json'}})
        : completion(init));
    await renderNewEntry();
    expect(renderer.root.findAllByType('LegacyDeviceComposer')).toHaveLength(0);
    expect(composer().props.availableModels).toEqual([{key:'glm-5',name:'GLM 5',description:null}]);
    await act(async()=>composer().props.onModelModeChange({key:'claude-unavailable',name:'Claude'}));
    await send('the real selected model');
    const call=fetcher.mock.calls.find(([url])=>url.endsWith('/stream'));
    expect(JSON.parse(call![1].body as string).model).toBe('glm-5');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Claude');
});
it.each(['empty','error'])('/new has no model fallback when the catalog is %s',async(state)=>{
    fetcher.mockResolvedValueOnce(state==='error'?new Response('',{status:503}):
        new Response(JSON.stringify({mode:'real',billable:true,models:[]}),{headers:{'content-type':'application/json'}}));
    await renderNewEntry();
    expect(composer().props.availableModels).toEqual([]);
    expect(composer().props.modelMode).toBeNull();
    expect(composer().props.blockSend).toBe(true);
    await send('must not send');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('LegacyDeviceComposer')).toHaveLength(0);
});
it('/new has no static choices while the model request is pending',async()=>{
    fetcher.mockImplementation(()=>new Promise(()=>{}));
    await renderNewEntry();
    expect(composer().props.availableModels).toEqual([]);
    expect(composer().props.blockSend).toBe(true);
    await send('must not send');
    expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['device','standalone'])('preserves deliberate %s sessions without a TokenHub catalog request',async(mode)=>{
    if(mode==='device')f.mode='device';else f.tokenHub=false;
    await renderNewEntry();
    expect(renderer.root.findAllByType('LegacyDeviceComposer')).toHaveLength(1);
    expect(renderer.root.findAllByType('AgentInput')).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
});
it('does not expose a legacy picker through an unauthenticated /new link',async()=>{
    f.isAuthenticated=false;await renderNewEntry();
    expect(renderer.root.findAllByType('Redirect')).toHaveLength(1);
    expect(renderer.root.findAllByType('LegacyDeviceComposer')).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
});
it('/new starts a fresh conversation but retains old encrypted history',async()=>{
    await render();await send('old conversation');
    await act(async()=>renderer.unmount());fetcher.mockClear();
    await renderNewEntry();await send('new conversation');
    const call=fetcher.mock.calls.find(([url])=>url.endsWith('/stream'));
    expect(JSON.parse(call![1].body as string).messages).toEqual([{role:'user',content:'new conversation'}]);
    expect(JSON.stringify(renderer.toJSON())).toContain('old conversation');
});
it('a restored unavailable model stays blocked rather than becoming a fake option',async()=>{
    await render();await send('saved conversation');await act(async()=>renderer.unmount());fetcher.mockClear();
    fetcher.mockImplementation(async(url:string,init:RequestInit)=>url.endsWith('/models')
        ? new Response(JSON.stringify({mode:'real',billable:true,models:[{id:'glm-5',name:'GLM 5'}]}),{headers:{'content-type':'application/json'}})
        : completion(init));
    await render();expect(composer().props.modelMode).toBeNull();expect(composer().props.blockSend).toBe(true);
    expect(composer().props.availableModels.map((x:any)=>x.key)).toEqual(['glm-5']);
    await send('must not use saved model');
    expect(fetcher.mock.calls.some(([url])=>url.endsWith('/stream'))).toBe(false);
});
