import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreDiagnostic } from './packages/happy-server/sources/app/tokenhub/coreDiagnostic.ts';
test('only known 503 diagnostics cross boundary', () => {
 for (const type of ['work_gateway_disabled','work_gateway_unavailable','work_authority_unavailable','work_key_lookup_unavailable']) assert.equal(coreDiagnostic(503, JSON.stringify({error:{type,message:'secret'}})),type);
 for (const body of ['secret', '{}', JSON.stringify({error:{type:'secret',message:'secret'}}), ' '.repeat(4097)]) assert.equal(coreDiagnostic(503,body),undefined);
 assert.equal(coreDiagnostic(401,JSON.stringify({error:{type:'work_gateway_disabled'}})),undefined);
});
