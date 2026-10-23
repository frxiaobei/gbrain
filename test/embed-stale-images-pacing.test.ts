import { execFileSync } from 'node:child_process';
/** Real image imports with a local provider stub: no paid requests. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { embedStaleImages, foldImageSweep } from '../src/core/embed-stale-images.ts';
import { configureGateway, resetGateway, reconfigureGatewayWithEngine } from '../src/core/ai/gateway.ts';
import { runSources } from '../src/commands/sources.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const originalFetch = globalThis.fetch;
let engine: PGLiteEngine;
const dirs: string[] = [];
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { globalThis.fetch = originalFetch; resetGateway(); await engine.disconnect(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }, 60_000);
async function seed(source: string, count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'image-pacing-')); dirs.push(dir);
  await runSources(engine, ['add', source, '--path', dir, '--no-federated', '--force']);
  for (let i = 0; i < count; i++) { const name = `image429-${i}.png`; writeFileSync(join(dir, name), PNG); await importImageFile(engine, join(dir, name), name, { noEmbed: true, sourceId: source }); }
  configureGateway({ embedding_model: 'voyage:voyage-multimodal-3', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-key' } });
  return dir;
}
function stub(status: number, observe: () => void) {
  globalThis.fetch = (async () => { observe(); return new Response(JSON.stringify(status === 200 ? { data: [{ embedding: Array(1024).fill(0.1), index: 0 }], model: 'voyage-multimodal-3' } : { error: 'provider unavailable' }), { status, headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
}
test('configured interval spaces actual provider requests and dry run does not call provider', async () => {
  await seed('pacing', 3); await engine.setConfig('embed.image_min_interval_ms', '150'); await reconfigureGatewayWithEngine(engine);
  const starts: number[] = []; stub(200, () => starts.push(performance.now()));
  expect((await embedStaleImages(engine, { sourceId: 'pacing', dryRun: true })).candidates).toBe(3);
  expect(starts).toHaveLength(0);
  expect(await embedStaleImages(engine, { sourceId: 'pacing', dryRun: false })).toMatchObject({ rebuilt: 3, failures: 0, deferred: 0, rate_limited: false });
  expect(starts).toHaveLength(3);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(145);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(145);
}, 60_000);
test('Voyage 429 stops after one failure and reports remaining candidates without claiming success', async () => {
  await seed('limited', 3); await engine.setConfig('embed.image_min_interval_ms', '0');
  let calls = 0; stub(429, () => calls++);
  const result = await embedStaleImages(engine, { sourceId: 'limited', dryRun: false });
  expect(result).toMatchObject({ rebuilt: 0, failures: 1, deferred: 2, rate_limited: true }); expect(calls).toBe(1);
  const folded = foldImageSweep({ failures: 0, failure_samples: [] as string[] }, result);
  expect(folded.failures).toBe(1); expect(folded.failure_samples[0]).toContain('2 deferred');
  expect((await embedStaleImages(engine, { sourceId: 'limited', dryRun: true })).candidates).toBe(3);
}, 60_000);
test('ordinary provider failure does not mistake a filename containing 429 for rate limiting', async () => {
  await seed('other-failure', 2); let calls = 0; stub(500, () => calls++);
  expect(await embedStaleImages(engine, { sourceId: 'other-failure', dryRun: false })).toMatchObject({ failures: 2, deferred: 0, rate_limited: false }); expect(calls).toBe(2);
}, 60_000);
test('budget cancellation interrupts the wait and leaves remaining candidates deferred', async () => {
  await seed('cancelled', 3); await engine.setConfig('embed.image_min_interval_ms', '5000'); await reconfigureGatewayWithEngine(engine);
  const controller = new AbortController(); let calls = 0;
  stub(200, () => { calls++; setTimeout(() => controller.abort(), 200); });
  const started = performance.now();
  const result = await embedStaleImages(engine, { sourceId: 'cancelled', dryRun: false, costCap: {
    signal: controller.signal,
    hit: () => controller.signal.aborted ? new BudgetExhausted('test cap reached', { reason: 'cost', spent: 1, cap: 1 }) : null,
    metered: fn => fn(),
  } });
  expect(result).toMatchObject({ rebuilt: 1, failures: 0, deferred: 2 }); expect(calls).toBe(1);
  expect(performance.now() - started).toBeLessThan(4000);
}, 60_000);

test('invalid interval refuses before provider work', async () => {
  await seed('invalid-config', 1); await engine.setConfig('embed.image_min_interval_ms', '-1'); await reconfigureGatewayWithEngine(engine);
  let calls = 0; stub(200, () => calls++);
  const result = await embedStaleImages(engine, { sourceId: 'invalid-config', dryRun: false }); expect(result.failures).toBe(1); expect(result.failure_samples[0]).toContain('embed.image_min_interval_ms');
  expect(calls).toBe(0);
}, 60_000);

test.skipIf(process.platform !== 'darwin')('JPEG asset bytes, MIME and mtime stay original while variant changes invalidate only the image vector', async () => {
  const dir = await seed('variant-copy', 0);
  globalThis.fetch = originalFetch;
  const encode = (await import('@jsquash/png/encode.js')).default;
  const sourcePng = join(dir, 'temporary.png');
  writeFileSync(sourcePng, Buffer.from(await encode({ width: 1200, height: 800, data: new Uint8ClampedArray(1200 * 800 * 4).fill(255) })));
  const sourceJpeg = join(dir, 'original.jpg');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', sourcePng, '--out', sourceJpeg]);
  rmSync(sourcePng);
  const original = readFileSync(sourceJpeg), mtime = statSync(sourceJpeg).mtimeMs;
  await engine.setConfig('embed.image_min_interval_ms', '0');
  // File-resolved gateway config must agree with stale selection even without a DB key.
  configureGateway({ embedding_model: 'voyage:voyage-multimodal-3', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024, embed_image_max_pixels: 200000, env: { VOYAGE_API_KEY: 'test-key' } });
  let calls = 0; stub(200, () => calls++);
  expect((await importImageFile(engine, sourceJpeg, 'original.jpg', { sourceId: 'variant-copy' })).status).toBe('imported');
  const page = (await engine.getPage('original.jpg', { sourceId: 'variant-copy' }))!;
  expect(page.frontmatter).toMatchObject({ mime_type: 'image/jpeg', bytes: original.length, image_embedding_variant: { signature: 'sips-fit-png-v1:max-pixels=200000', output_mime: 'image/png' } });
  expect(await engine.getFile('variant-copy', 'original.jpg')).toMatchObject({ mime_type: 'image/jpeg' });
  expect(readFileSync(sourceJpeg).equals(original)).toBe(true); expect(statSync(sourceJpeg).mtimeMs).toBe(mtime);
  expect((await embedStaleImages(engine, { sourceId: 'variant-copy', dryRun: true })).candidates).toBe(0);
  await engine.setConfig('embed.image_max_pixels', '100000'); await reconfigureGatewayWithEngine(engine);
  expect((await embedStaleImages(engine, { sourceId: 'variant-copy', dryRun: true })).candidates).toBe(1);
  expect((await embedStaleImages(engine, { sourceId: 'variant-copy', dryRun: false })).rebuilt).toBe(1);
  expect(calls).toBe(2); expect(readFileSync(sourceJpeg).equals(original)).toBe(true);expect(statSync(sourceJpeg).mtimeMs).toBe(mtime);
  await engine.setConfig('embed.image_max_pixels', '0');
},60000);
