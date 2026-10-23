/** Real durable queue, six roots and consumer clocks; provider HTTP is a free stub. */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { configureGateway, embedMultimodal, resetGateway } from '../src/core/ai/gateway.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

for (const mixed of [false,true]) describe(`owner admission mixed=${mixed}`, () => {
 let engine: PGLiteEngine;
 beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
 afterAll(async () => { await engine.disconnect(); });
 test(`paced image claims preserve attempts and foreground progress (mixed deferred head=${mixed})`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'gbrain-provider-owner-'));
 const interval=Number(process.env.GBRAIN_TEST_IMAGE_REAL_INTERVAL_MS ?? 250);
 const prepBudget=interval>=61000?120000:200;
 const config:HarnessConfig={kind:'pglite',root:home,dataDir:join(home,'data'),hostId:randomUUID(),seed:5105,schedules:0,operations:0,sourceIds:Array.from({length:6},(_,i)=>`image-owner-${i}`),principalIds:[randomUUID()]};
 const oldFetch=globalThis.fetch;let consumer:PersistenceConsumer|undefined;
 try { await withEnv({GBRAIN_HOME:home,GBRAIN_PERSISTENCE_FIXTURE_HOME:home},async()=>{
  selectFixtureHost(config.hostId);await initializeFixtures(engine,config);
  const sources=await fixtures(engine,config);const rows: import('../src/core/persistence/model.ts').WriteRequest[]=[];
  const batch=randomUUID();
  if(mixed) await admitWrite(engine,admission(config,sources[0]!,'head','head',0,{intent:{kind:'managed_file_import',sourcePath:'head.md',content:'head',embedDeferred:true,import_batch:batch}}));
  for(let i=0;i<6;i++) rows.push(await admitWrite(engine,admission(config,sources[mixed?0:i]!,`image-${i}.png`,'test',0,{intent:{kind:'managed_file_import',sourcePath:`image-${i}.png`,content:'test',noEmbed:false,...(mixed?{import_batch:batch}:{})}})));
  const foreground=await admitWrite(engine,admission(config,sources[0]!,'note','foreground'));
  configureGateway({embedding_model:'voyage:voyage-multimodal-3',embedding_dimensions:1024,embed_image_min_interval_ms:interval,env:{VOYAGE_API_KEY:'test-only'}});
  const starts:number[]=[];let preparations=0;
  globalThis.fetch=(async()=>{starts.push(Date.now());return new Response(JSON.stringify({data:[{embedding:Array(1024).fill(.1)}],usage:{total_tokens:1}}));}) as unknown as typeof fetch;
  consumer=new PersistenceConsumer(engine,{engine:'pglite'},async(_e,row,_cfg,_signal,clock)=>{
   if(row.slug.endsWith('.png')){preparations++;await embedMultimodal([{kind:'text',text:'fixture image request'}],{signal:clock?.signal});}
   return prepared(row,sources);
  },{hostId:config.hostId,concurrency:6,pollMs:20,requestsOnly:true,preparationBudgets:{syncMs:prepBudget,maintenanceMs:prepBudget,maxAttempts:2}});
  consumer.start();
  await waitFor(()=>starts.length>=1,{timeoutMs:10000});
  const waiting=await engine.executeRaw<{state:string;preparation_attempts:number}>('SELECT state,preparation_attempts FROM persistence_requests WHERE slug LIKE $1',['image-%']);
  expect(waiting.some(r=>r.state==='queued')).toBe(true);expect(waiting.every(r=>r.preparation_attempts===0)).toBe(true);
  await waitFor(async()=> (await getWriteRequestById(engine,foreground.id))?.state==='committed',{timeoutMs:Math.max(10000,interval+5000)});
  await waitFor(async()=> (await Promise.all(rows.map(r=>getWriteRequestById(engine,r.id)))).every(r=>r?.state==='committed'),{timeoutMs:interval*7+15000});
  expect(preparations).toBe(6);expect(starts).toHaveLength(6);
  for(let i=1;i<starts.length;i++)expect(starts[i]!-starts[i-1]!).toBeGreaterThanOrEqual(interval-5);
  for(const row of rows)expect(await getWriteRequestById(engine,row.id)).toMatchObject({state:'committed',preparation_attempts:0});
 }); } finally {await consumer?.stop();globalThis.fetch=oldFetch;resetGateway();rmSync(home,{recursive:true,force:true});}
},480000);
});
