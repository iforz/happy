// Code-native Work monogram; does not modify upstream copyright/logo assets.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../packages/happy-app/package.json',import.meta.url));
const sharp=require('sharp');
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#183f38"/><path d="M24 35l17 59h12l11-35 11 35h12l17-59H89L80 71 69 35H59L48 71 39 35z" fill="#fff"/></svg>';
const directory=new URL('../../packages/happy-app/sources/assets/images/',import.meta.url);
await fs.writeFile(new URL('work-mark.svg',directory),svg);
await sharp(Buffer.from(svg)).resize(1024,1024).png().toFile(new URL('work-mark.png',directory).pathname);
const png=await sharp(Buffer.from(svg)).resize(48,48).png().toBuffer();
await fs.writeFile(new URL('work-favicon.png',directory),png);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=48;ico[7]=48;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
await fs.writeFile(new URL('../../packages/happy-app/public/favicon-active.ico',import.meta.url),Buffer.concat([ico,png]));
