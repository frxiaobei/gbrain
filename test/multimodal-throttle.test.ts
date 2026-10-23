import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMultimodalPermit } from '../src/core/ai/multimodal-throttle.ts';

describe('shared multimodal HTTP pacing', () => {
  test('two processes share spacing, including failed attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-provider-test-'));
    const helper = join(dir, 'request.ts');
    await writeFile(helper, `import { withMultimodalPermit } from ${JSON.stringify(join(import.meta.dir, '../src/core/ai/multimodal-throttle.ts'))}; await withMultimodalPermit(100, 1000, undefined, async () => { console.log(Date.now()); if(process.argv[3] === 'fail') throw new Error('429'); }, process.argv[2]).catch(()=>{});`);
    try {
      const a = Bun.spawn([process.execPath, helper, dir, 'fail'], { stdout: 'pipe' });
      const b = Bun.spawn([process.execPath, helper, dir, 'ok'], { stdout: 'pipe' });
      const dates = await Promise.all([a,b].map(async c => { const t=Number((await new Response(c.stdout).text()).trim()); await c.exited; return t; }));
      expect(Math.abs(dates[0]! - dates[1]!)).toBeGreaterThanOrEqual(95);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  test('cancelled waiter sends nothing and releases its lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-provider-test-'));
    try {
      await withMultimodalPermit(200,1000,undefined,async()=>{},dir);
      const abort = new AbortController();
      setTimeout(()=>abort.abort(),20);
      let sent=false;
      await expect(withMultimodalPermit(200,1000,abort.signal,async()=>{sent=true;},dir)).rejects.toThrow();
      expect(sent).toBe(false);
      await withMultimodalPermit(200,1000,undefined,async()=>{sent=true;},dir);
      expect(sent).toBe(true);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  test('killed sender leaves the full outstanding HTTP reservation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-provider-test-'));
    const helper=join(dir,'holder.ts');
    await writeFile(helper,`import {withMultimodalPermit} from ${JSON.stringify(join(import.meta.dir,'../src/core/ai/multimodal-throttle.ts'))}; await withMultimodalPermit(70,500,undefined,async()=>{console.log('ready');await new Promise(()=>{});},process.argv[2]);`);
    const child=Bun.spawn([process.execPath,helper,dir],{stdout:'pipe'});
    try {
      const reader=child.stdout.getReader();await reader.read();child.kill(9);await child.exited;
      const state=JSON.parse(await readFile(join(dir,'permit.json'),'utf8'));
      let sentAt=0;await withMultimodalPermit(70,500,undefined,async()=>{sentAt=Date.now();},dir);
      expect(sentAt).toBeGreaterThanOrEqual(state.nextAllowedAt-5);
    } finally { child.kill();await rm(dir,{recursive:true,force:true}); }
  });
  test('corrupt state fails closed',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'gbrain-provider-test-'));let sent=false;
    try{for(const value of ['broken','null','false','0','{}']) { await writeFile(join(dir,'permit.json'),value);await expect(withMultimodalPermit(20,500,undefined,async()=>{sent=true;},dir)).rejects.toThrow(); } expect(sent).toBe(false);}
    finally{await rm(dir,{recursive:true,force:true});}
  });
});
