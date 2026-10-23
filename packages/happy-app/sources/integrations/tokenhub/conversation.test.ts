import {describe,it,expect,vi} from 'vitest';
import {conversationInput,requireRealCatalog,selectedModelAllowed} from './conversation';
import {createWorkMockClient} from './workMockClient';
describe('formal authorized conversation',()=>{
 it('keeps multi-turn roles and excludes incomplete responses',()=>expect(conversationInput([{user:'first',assistant:'answer',status:'complete'},{user:'cancelled',assistant:'partial',status:'cancelled'}],'next')).toEqual([{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'next'}]));
 it('does not truncate history silently',()=>expect(()=>conversationInput([{user:'x'.repeat(16000),assistant:'answer',status:'complete'}],'next')).toThrow());
 it('rejects mock, stale and absent selections',()=>{expect(()=>requireRealCatalog({mode:'mock',billable:false,models:[]})).toThrow();expect(selectedModelAllowed(null,'claude')).toBe(false);expect(selectedModelAllowed({mode:'real',billable:true,models:[{id:'qwen-current',name:'Qwen'}]},'saved-model')).toBe(false)});
 it('sends the selected non-Claude model and history once through the authorized gateway',async()=>{
  const requestId='60a399cd-f49f-4064-8fe6-46d2d6d9c0d0';
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({mode:'real',billable:true,models:[{id:'qwen-current',name:'Qwen'},{id:'default',name:'Default model'}]}),{headers:{'content-type':'application/json'}}));
  const events=[{type:'delta',text:'answer'},{type:'usage',model:'qwen-current',requestId,inputTokens:8,outputTokens:2,mock:false,billable:true,accounting:'core'},{type:'done'}];
  fetch.mockResolvedValueOnce(new Response(events.map(v=>JSON.stringify(v)).join('\n')+'\n',{headers:{'content-type':'application/x-ndjson'}}));
  const client=createWorkMockClient({baseUrl:'https://work.example',requireRealCatalog:true,tokenProvider:async()=>'test-work-token',fetch});
  const catalog=await client.getCatalog();expect(catalog.models.map(m=>m.id)).toEqual(['qwen-current']);
  const messages=conversationInput([{user:'first',assistant:'answer',status:'complete'}],'next');
  const usage=await client.stream({model:'qwen-current',messages,requestId},()=>{});
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1][0]).toBe('https://work.example/v1/tokenhub/work/stream');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({model:'qwen-current',messages,requestId});expect(usage.accounting).toBe('core');
 });
 it('forbids sending after catalog refresh failure without any fallback or retry',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({mode:'real',billable:true,models:[{id:'claude-real',name:'Claude'}]}),{headers:{'content-type':'application/json'}})).mockResolvedValueOnce(new Response('',{status:503}));
  const client=createWorkMockClient({baseUrl:'https://work.example',requireRealCatalog:true,tokenProvider:async()=>'test-token',fetch});
  await client.getCatalog();await expect(client.getCatalog()).rejects.toThrow();await expect(client.stream({model:'claude-real',prompt:'hi',requestId:'60a399cd-f49f-4064-8fe6-46d2d6d9c0d0'},()=>{})).rejects.toMatchObject({kind:'configuration'});expect(fetch).toHaveBeenCalledTimes(2);
 });
});
