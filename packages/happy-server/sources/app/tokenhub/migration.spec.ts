import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
it('applies the additive migration idempotently and enforces both identity constraints',async()=>{
 const pg=new PGlite();try{
  await pg.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY,"publicKey" TEXT NOT NULL UNIQUE); INSERT INTO "Account" VALUES (\'a\',\'key-a\'),(\'b\',\'key-b\')');
  const sql=await readFile(resolve('prisma/migrations/20261022100000_tokenhub_identity/migration.sql'),'utf8');
  await pg.exec(sql);await pg.exec(sql);
  await pg.query('INSERT INTO "TokenHubIdentity" ("authority","issuer","subject","accountId") VALUES ($1,$2,$3,$4)',['https://accounts.example.test','tokenapi','42','a']);
  await expect(pg.query('INSERT INTO "TokenHubIdentity" ("authority","issuer","subject","accountId") VALUES ($1,$2,$3,$4)',['https://accounts.example.test','tokenapi','42','b'])).rejects.toMatchObject({code:'23505'});
  await expect(pg.query('INSERT INTO "TokenHubIdentity" ("authority","issuer","subject","accountId") VALUES ($1,$2,$3,$4)',['https://accounts.example.test','tokenapi','99','a'])).rejects.toMatchObject({code:'23505'});
  expect((await pg.query('SELECT * FROM "Account"')).rows).toHaveLength(2);
 }finally{await pg.close()}
},30000);
