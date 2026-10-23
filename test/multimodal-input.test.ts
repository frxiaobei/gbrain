import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { prepareMultimodalImage } from '../src/core/ai/multimodal-input.ts';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
test('default disabled preserves identical original bytes',async()=>{const result=await prepareMultimodalImage(PNG,'image/png',0);expect(result.bytes).toBe(PNG);expect(result.variant).toBeUndefined();});
test('invalid pixel configuration fails before preprocessing',async()=>{await expect(prepareMultimodalImage(PNG,'image/png',16_000_001)).rejects.toThrow('16000000');});
test.skipIf(process.platform!=='darwin')('sips creates an aspect-preserving bounded copy with a reproducible variant',async()=>{
 const encode=(await import('@jsquash/png/encode.js')).default;
 const original=Buffer.from(await encode({width:2000,height:1000,data:new Uint8ClampedArray(2000*1000*4).fill(255)}));
 const before=createHash('sha256').update(original).digest('hex');
 const result=await prepareMultimodalImage(original,'image/png',200_000);
 expect(result.variant?.signature).toBe('sips-fit-png-v1:max-pixels=200000');
 expect(result.variant!.width*result.variant!.height).toBeLessThanOrEqual(200_000);
 expect(result.variant!.width/result.variant!.height).toBeCloseTo(2,1);
 expect(result.variant!.source_sha256).toBe(before);expect(createHash('sha256').update(original).digest('hex')).toBe(before);
 const again=await prepareMultimodalImage(result.bytes,result.mime,200_000);expect(again.bytes.equals(result.bytes)).toBe(true);
},60000);
test.skipIf(process.platform==='darwin')('enabled preprocessing refuses missing host capability',async()=>{await expect(prepareMultimodalImage(PNG,'image/png',1000)).rejects.toThrow('requires macOS');});
test('cancelled preprocessing never starts a subprocess',async()=>{const abort=new AbortController();abort.abort();await expect(prepareMultimodalImage(PNG,'image/png',1000,abort.signal)).rejects.toThrow();});
