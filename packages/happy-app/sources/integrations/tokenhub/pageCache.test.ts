import { describe, it, expect } from 'vitest';
import { readCachedConfig } from './pageCache';
import { defaultPageConfig } from './pageConfig';
describe('offline configuration',()=>{
 it('uses validated cached copy but disables offline federation',()=>{const now=1000000;const value={at:now,origin:'https://accounts.example.test',config:{...defaultPageConfig,ssoReady:true,showLogin:true,loginUrl:'https://accounts.example.test/happy/authorize'}};const storage={getItem:()=>JSON.stringify(value)};expect(readCachedConfig(storage,'key',now)?.ssoReady).toBe(false);expect(readCachedConfig(storage,'key',now)?.brandName).toBe('Work');expect(readCachedConfig(storage,'key',now+3*86400000)).toBeNull();});
 it('rejects corrupt cache, blocked storage, future timestamps and unsafe links',()=>{expect(readCachedConfig({getItem:()=>'{bad'},'k')).toBeNull();expect(readCachedConfig({getItem:()=>{throw new Error('blocked')}},'k')).toBeNull();expect(readCachedConfig({getItem:()=>JSON.stringify({at:100,origin:'https://accounts.example.test',config:defaultPageConfig})},'k',99)).toBeNull();expect(readCachedConfig({getItem:()=>JSON.stringify({at:0,origin:'https://accounts.example.test',config:{...defaultPageConfig,helpUrl:'javascript:alert(1)'}})},'k',100)).toBeNull();});
});
