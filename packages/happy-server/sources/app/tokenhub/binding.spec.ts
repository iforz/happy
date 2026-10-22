import { it, expect, vi } from 'vitest';
import { bindIdentity } from './binding';
it('preserves the existing public-key identity and rejects a different key before writes', async () => {
 const upsert=vi.fn(); const record={issuer:'tokenapi',subject:'42',accountId:'existing-account',account:{publicKey:'original-key'}};
 const tx={tokenHubIdentity:{findUnique:vi.fn().mockResolvedValue(record)},account:{upsert}}; const db={$transaction:(f:Function)=>f(tx)};
 expect(await bindIdentity(db,'https://accounts.example.test',{issuer:'tokenapi',subject:'42'},'original-key')).toBe('existing-account');
 await expect(bindIdentity(db,'https://accounts.example.test',{issuer:'tokenapi',subject:'42'},'different-key')).rejects.toThrow('identity_key_mismatch');expect(upsert).not.toHaveBeenCalled();
});
it('links an existing Happy account without changing its secret or metadata',async()=>{
 const create=vi.fn().mockResolvedValue({});const upsert=vi.fn().mockResolvedValue({id:'native-account'});
 const db={$transaction:(f:Function)=>f({tokenHubIdentity:{findUnique:vi.fn().mockResolvedValue(null),create},account:{upsert}})};
 expect(await bindIdentity(db,'https://accounts.example.test',{issuer:'tokenapi',subject:'42'},'key')).toBe('native-account');expect(upsert).toHaveBeenCalledWith({where:{publicKey:'key'},update:{},create:{publicKey:'key'}});expect(create).toHaveBeenCalledWith({data:{authority:'https://accounts.example.test',issuer:'tokenapi',subject:'42',accountId:'native-account'}});
});
it('re-reads the unique-constraint winner without overwriting a concurrent binding',async()=>{
 const identity={issuer:'tokenapi',subject:'42'};const winner={...identity,accountId:'winning-account',account:{publicKey:'key'}};
 const db={$transaction:vi.fn().mockRejectedValue({code:'P2002'}),tokenHubIdentity:{findUnique:vi.fn().mockResolvedValue(winner)}};
 expect(await bindIdentity(db,'https://accounts.example.test',identity,'key')).toBe('winning-account');
 await expect(bindIdentity(db,'https://accounts.example.test',identity,'different-key')).rejects.toThrow('identity_key_mismatch');
});
