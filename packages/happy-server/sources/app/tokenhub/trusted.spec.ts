import { it, expect, vi } from 'vitest';
import { trustedTokenHubOrigin, trustedJson } from './trusted';
import { validatePageConfig, validateLoginOrigin, defaultPageConfig } from '@slopus/happy-wire';
it('rejects SSRF destinations and never accepts a remote-provided fetch URL',async()=>{
 for(const url of ['http://accounts.example.test','https://127.0.0.1','https://localhost','https://user:pass@accounts.example.test','https://accounts.example.test/path','https://accounts.example.test/?target=evil'])expect(()=>trustedTokenHubOrigin(url)).toThrow();
 const fetcher=vi.fn();await expect(trustedJson('https://accounts.example.test','https://attacker.test',{},fetcher)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
it('omits credentials, rejects redirects and bounds remote response size',async()=>{
 const f=vi.fn().mockResolvedValue(new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}}));await trustedJson('https://accounts.example.test','/api/v1/settings/happy',{},f);expect(f).toHaveBeenCalledWith('https://accounts.example.test/api/v1/settings/happy',expect.objectContaining({credentials:'omit',redirect:'error',cache:'no-store'}));
 f.mockResolvedValue(new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}}));await expect(trustedJson('https://accounts.example.test','/api/v1/settings/happy',{},f)).rejects.toThrow();
});
it('validates version and dangerous URL schemes without interpreting markup',()=>{
 const good={...defaultPageConfig,brandName:'<script>not executable</script>'};expect(validatePageConfig(good).brandName).toBe(good.brandName);
 for(const logoUrl of ['javascript:alert(1)','data:image/svg+xml,<svg/>','https://example.test/logo.svg'])expect(()=>validatePageConfig({...good,logoUrl})).toThrow();expect(()=>validatePageConfig({...good,schemaVersion:2})).toThrow();expect(()=>validateLoginOrigin({...good,loginUrl:'https://attacker.test/happy/authorize'},'https://accounts.example.test')).toThrow();
});
