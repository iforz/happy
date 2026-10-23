import test from 'node:test';
import assert from 'node:assert/strict';
import { workClientContext } from '../../packages/happy-server/sources/app/tokenhub/clientContext.ts';
const request = (peer, forwarded, extra = {}) => ({socket:{remoteAddress:peer},headers:{'x-real-ip':forwarded,'user-agent':'browser',...extra}});
test('loopback proxy trust is opt-in and cannot trust external forwarding headers',()=>{
 assert.equal(workClientContext(request('127.0.0.1','198.51.100.9'),'false').ip,'127.0.0.1');
 assert.equal(workClientContext(request('203.0.113.8','198.51.100.9'),'true').ip,'203.0.113.8');
});
test('HTTP and socket raw requests resolve the same overwritten client address',()=>{
 for(const peer of ['127.0.0.1','::1','::ffff:127.0.0.1']) assert.deepEqual(workClientContext(request(peer,'198.51.100.9',{'x-forwarded-for':'spoofed, 127.0.0.1','x-client-ip':'spoofed'}),'true'),{ip:'198.51.100.9',userAgent:'browser'});
 assert.equal(workClientContext(request('127.0.0.1','::ffff:198.51.100.9'),'true').ip,'198.51.100.9');
});
test('malformed or missing trusted-proxy addresses fail closed',()=>{
 for(const value of [undefined,['198.51.100.9','203.0.113.9'],'198.51.100.9, 127.0.0.1',' 198.51.100.9','198.51.100.9:443','spoofed'])assert.throws(()=>workClientContext(request('127.0.0.1',value),'true'));
 assert.throws(()=>workClientContext(request('127.0.0.1','198.51.100.9'),'anything'));
});
