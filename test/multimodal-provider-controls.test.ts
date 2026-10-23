import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, embedMultimodal, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { BudgetTracker, parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
const originalFetch=globalThis.fetch;
import { withEnv } from './helpers/with-env.ts';
function test(name: string, fn: () => Promise<void>, timeout = 60000) { bunTest(name, () => withEnv({ GBRAIN_HOME: dir }, fn), timeout); }
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'gbrain-mm-provider-'));});
afterEach(()=>{globalThis.fetch=originalFetch;resetGateway();rmSync(dir,{recursive:true,force:true});});
function setup(interval=20,batch=1,cap=9000){configureGateway({embedding_model:'voyage:voyage-multimodal-3',embedding_multimodal_model:'voyage:voyage-multimodal-3',embedding_dimensions:1024,embed_image_min_interval_ms:interval,embed_image_batch_size:batch,embed_image_max_request_tokens:cap,env:{VOYAGE_API_KEY:'test-only'}});}
function provider(status:number,observe:(n:number)=>void){globalThis.fetch=(async(_url: string | URL | Request,options?: RequestInit)=>{const n=JSON.parse(String(options?.body)).inputs.length;observe(n);return new Response(JSON.stringify(status===200?{data:Array.from({length:n},(_,index)=>({index,embedding:Array(1024).fill(0.1)})),usage:{total_tokens:n}}:{error:'limited'}),{status});}) as unknown as typeof fetch;}
test('more than 32 inputs obey each actual request gate and single-input size',async()=>{
 setup(10);const times:number[]=[];provider(200,n=>{expect(n).toBe(1);times.push(Date.now());});
 expect(await embedMultimodal(Array.from({length:33},()=>({kind:'text' as const,text:'hello'})))).toHaveLength(33);
 expect(times).toHaveLength(33);for(let i=1;i<times.length;i++)expect(times[i]!-times[i-1]!).toBeGreaterThanOrEqual(8);
},60000);
test('429 ends one attempt, and a separate caller still waits for the shared permit',async()=>{
 setup(100);const times:number[]=[];provider(429,()=>times.push(Date.now()));await expect(embedMultimodal([{kind:'text',text:'first'}])).rejects.toThrow('429');
 provider(200,()=>times.push(Date.now()));await embedMultimodal([{kind:'text',text:'second'}]);expect(times[1]!-times[0]!).toBeGreaterThanOrEqual(95);
},60000);
test('cancellation before send releases reserved spend',async()=>{
 setup(1000);let sent=0;provider(200,()=>sent++);await embedMultimodal([{kind:'text',text:'seed'}]);
 const tracker=new BudgetTracker({maxCostUsd:1,label:'test'});const abort=new AbortController();setTimeout(()=>abort.abort(),20);
 await expect(withBudgetTracker(tracker,()=>embedMultimodal([{kind:'text',text:'cancel me'}],{signal:abort.signal}))).rejects.toThrow();expect(sent).toBe(1);expect(tracker.totalSpent).toBe(0);
},60000);
test('UTF8 text plus framing obeys total request bound without truncation',async()=>{
 setup(0,1,9000);let sent=0;provider(200,()=>sent++);await expect(embedMultimodal([{kind:'text',text:'字'.repeat(3000)}])).rejects.toThrow('exceeds');expect(sent).toBe(0);
});

test('non-Voyage requests that were sent retain their failed-attempt budget charge',async()=>{
 configureGateway({embedding_model:'litellm:gpt-4o-multimodal',embedding_dimensions:1024,env:{LITELLM_API_KEY:'test'},base_urls:{litellm:'http://localhost:4000'}});
 let sent=0;globalThis.fetch=(async()=>{sent++;return new Response('failure',{status:500});}) as unknown as typeof fetch;
 const tracker=new BudgetTracker({maxCostUsd:1,label:'compat failure',pricingOverrides:parsePricingOverrides({'litellm:gpt-4o-multimodal':{input:1,output:1}})});
 await expect(withBudgetTracker(tracker,()=>embedMultimodal([{kind:'text',text:'actual sent request'}]))).rejects.toThrow();
 expect(sent).toBe(1);expect(tracker.totalSpent).toBeGreaterThan(0);
});
