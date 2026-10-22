import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { tokenHubRoutes } from './tokenHubRoutes';
import { defaultPageConfig } from '@slopus/happy-wire';
import type { Fastify } from '../types';
const origin='https://accounts.example.test', self='https://happy.example.test';
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
let app:ReturnType<typeof fastify>;
beforeEach(()=>{vi.stubEnv('TOKENHUB_URL',origin);vi.stubEnv('HAPPY_PUBLIC_ORIGIN',self);vi.stubEnv('TOKENHUB_SSO_ENABLED','true');app=fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);});
afterEach(async()=>{await app.close();vi.unstubAllEnvs();});
function setup(options:{mismatch?:boolean,badAudience?:boolean}={}){
 const pair=generateKeyPairSync('ed25519');const publicKey=Buffer.from(pair.publicKey.export({format:'jwk'}).x!,'base64url').toString('base64');
 let nonce='',challenge='',used=false;const bind=vi.fn(async()=>{if(options.mismatch)throw new Error('identity_key_mismatch');return 'existing-happy-account'});
 const transport=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  const u=String(url);let data:unknown;
  if(u===origin+'/api/v1/auth/happy/metadata')data={code:0,data:{issuer:'tokenapi',audience:'happy-web',enabled:true,jwks_path:'https://attacker.test/key'}};
  else if(u===origin+'/api/v1/auth/sso/jwks')data={keys:[{...rsa.publicKey.export({format:'jwk'}),kid:'sso-1',alg:'RS256',use:'sig'}]};
  else if(u===origin+'/api/v1/auth/happy/exchange'){
   const r=JSON.parse(String(init?.body));expect(r.redirect_uri).toBe(self+'/tokenhub/callback');expect(createHash('sha256').update(r.code_verifier).digest('base64url')).toBe(challenge);expect(r.client_id).toBe('happy-web');
   if(used||r.code!=='one-time-code')return new Response('{}',{status:400,headers:{'content-type':'application/json'}});used=true;
   const now=Math.floor(Date.now()/1000);data={code:0,data:{id_token:jwt.sign({iss:'tokenapi',sub:'42',aud:options.badAudience?'wrong':'happy-web',nonce,jti:randomBytes(32).toString('base64url'),iat:now,nbf:now,exp:now+60},rsa.privateKey,{algorithm:'RS256',keyid:'sso-1'})}};
  }else throw new Error('Unexpected destination');
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 });
 const pageConfig=async()=>({...defaultPageConfig,showLogin:true,ssoReady:true,loginUrl:origin+'/happy/authorize'});
 tokenHubRoutes(app as unknown as Fastify,{transport:transport as typeof fetch,pageConfig,bind,token:async()=> 'native-happy-session'});
 return{pair,publicKey,bind,transport,async start(){const r=await app.inject({method:'POST',url:'/v1/tokenhub/start',headers:{origin:self},payload:{publicKey}});expect(r.statusCode).toBe(200);const data=r.json();const url=new URL(data.authorizeUrl);nonce=url.searchParams.get('nonce')!;challenge=url.searchParams.get('code_challenge')!;const h=r.headers['set-cookie'];const cookie=(Array.isArray(h)?h[0]:String(h)).split(';')[0];return{...data,cookie,signature:sign(null,Buffer.from(data.proof),pair.privateKey).toString('base64')}}};
}
it('wires public config and blocks a foreign browser origin',async()=>{const s=setup();const config=await app.inject('/v1/tokenhub/config');expect(config.statusCode).toBe(200);expect(config.json().config.brandName).toBe('Happy');expect(config.headers['cache-control']).toBe('no-store');const rejected=await app.inject({method:'POST',url:'/v1/tokenhub/start',headers:{origin:'https://attacker.test'},payload:{publicKey:s.publicKey}});expect(rejected.statusCode).toBe(403);expect(s.transport).not.toHaveBeenCalled();});
it('exchanges one-time code, verifies assertions and issues only a native Happy session',async()=>{const s=setup(),f=await s.start();expect(new URL(f.authorizeUrl).origin).toBe(origin);const request={method:'POST' as const,url:'/v1/tokenhub/complete',headers:{origin:self,cookie:f.cookie},payload:{state:f.state,code:'one-time-code',signature:f.signature}};const r=await app.inject(request);expect(r.statusCode).toBe(200);expect(r.json()).toEqual({token:'native-happy-session'});expect(s.bind).toHaveBeenCalledWith(origin,{issuer:'tokenapi',subject:'42'},Buffer.from(s.publicKey,'base64').toString('hex'));expect((await app.inject(request)).statusCode).toBe(400);expect(s.bind).toHaveBeenCalledTimes(1);});
it('consumes cancellation without fetching tokens or binding an account',async()=>{const s=setup(),f=await s.start();const r=await app.inject({method:'POST',url:'/v1/tokenhub/complete',headers:{origin:self,cookie:f.cookie},payload:{state:f.state,error:'access_denied'}});expect(r.statusCode).toBe(400);expect(r.json().error).toBe('Login cancelled');expect(s.transport).not.toHaveBeenCalled();expect(s.bind).not.toHaveBeenCalled();});
it('rejects wrong proof and wrong assertion audience before any binding',async()=>{const s=setup({badAudience:true}),f=await s.start();const r=await app.inject({method:'POST',url:'/v1/tokenhub/complete',headers:{origin:self,cookie:f.cookie},payload:{state:f.state,code:'one-time-code',signature:f.signature}});expect(r.statusCode).toBe(400);expect(s.bind).not.toHaveBeenCalled();});
it('requires recovery instead of replacing an existing encryption identity',async()=>{const s=setup({mismatch:true}),f=await s.start();const r=await app.inject({method:'POST',url:'/v1/tokenhub/complete',headers:{origin:self,cookie:f.cookie},payload:{state:f.state,code:'one-time-code',signature:f.signature}});expect(r.statusCode).toBe(409);expect(r.json().error).toContain('Restore the original');});
it('does not clear a newer cookie on a stale callback',async()=>{const s=setup(),old=await s.start(),current=await s.start();const stale=await app.inject({method:'POST',url:'/v1/tokenhub/complete',headers:{origin:self,cookie:current.cookie},payload:{state:old.state,code:'one-time-code',signature:old.signature}});expect(stale.statusCode).toBe(400);expect(stale.headers['set-cookie']).toBeUndefined();const good=await app.inject({method:'POST',url:'/v1/tokenhub/complete',headers:{origin:self,cookie:current.cookie},payload:{state:current.state,code:'one-time-code',signature:current.signature}});expect(good.statusCode).toBe(200);});
