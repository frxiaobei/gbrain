/** Explicit macOS-only bounded provider copies. Source bytes are never written. */
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from '../spawn.ts';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AIConfigError } from './errors.ts';
const run = promisify(execFile);
const MAX_SOURCE_PIXELS = 100_000_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export interface ImageVariant {
  signature: string; source_sha256: string; output_sha256: string; output_mime: string;
  source_width: number; source_height: number; width: number; height: number;
}
export function imageVariantSignature(maxPixels: number): string | null {
  return maxPixels > 0 ? `sips-fit-png-v1:max-pixels=${maxPixels}` : null;
}
export async function prepareMultimodalImage(bytes: Buffer, mime: string, maxPixels: number, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string; variant?: ImageVariant }> {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 0 || maxPixels > 16_000_000) throw new AIConfigError('embed.image_max_pixels must be an integer from 0 to 16000000');
  if (maxPixels === 0) return { bytes, mime };
  signal?.throwIfAborted();
  if (process.platform !== 'darwin') throw new AIConfigError('Image preprocessing was enabled but requires macOS /usr/bin/sips; no provider request sent');
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new AIConfigError('Image preprocessing input exceeds 20 MiB; no provider request sent');
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-image-provider-'));
  await chmod(dir, 0o700);
  try {
    const source = join(dir, 'source');
    await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
    const dimensions = async (file: string) => {
      const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { signal, timeout: 30_000, maxBuffer: 16_384 });
      const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new AIConfigError('Cannot read image dimensions; no provider request sent');
      return { width, height };
    };
    const original = await dimensions(source);
    if (original.width * original.height > MAX_SOURCE_PIXELS) throw new AIConfigError('Image exceeds the 100 million source-pixel decoding bound; no provider request sent');
    // Animated GIF semantics cannot be preserved by sips; refuse instead of
    // silently choosing a frame. Existing unconfigured behavior is untouched.
    if (mime === 'image/gif') throw new AIConfigError('Configured sips preprocessing does not support animated GIF preservation; no provider request sent');
    if (mime === 'image/png' && original.width * original.height <= maxPixels) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      return { bytes, mime, variant: { signature: imageVariantSignature(maxPixels)!, output_mime: 'image/png', source_sha256: hash, output_sha256: hash, source_width: original.width, source_height: original.height, ...original } };
    }
    const output = join(dir, 'provider.png');
    await writeFile(output, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    const side = Math.max(1, Math.floor(Math.max(original.width, original.height) * Math.min(1, Math.sqrt(maxPixels / (original.width * original.height)))));
    await run('/usr/bin/sips', ['--resampleHeightWidthMax', String(side), '--setProperty', 'format', 'png', source, '--out', output], { signal, timeout: 30_000, maxBuffer: 16_384 });
    await chmod(output, 0o600);
    const resized = await dimensions(output);
    if (resized.width * resized.height > maxPixels) throw new AIConfigError('Image preprocessing exceeded its pixel bound; no provider request sent');
    const prepared = await readFile(output);
    if (prepared.byteLength > MAX_SOURCE_BYTES) throw new AIConfigError('Prepared image exceeds provider byte limit; no provider request sent');
    const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    return { bytes: prepared, mime: 'image/png', variant: { signature: imageVariantSignature(maxPixels)!, output_mime: 'image/png', source_sha256: sha(bytes), output_sha256: sha(prepared), source_width: original.width, source_height: original.height, ...resized } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

import type { AIGatewayConfig, MultimodalInput } from './types.ts';
export async function prepareMultimodalBatch(inputs: MultimodalInput[], cfg: AIGatewayConfig, tokenCap: number, signal?: AbortSignal): Promise<MultimodalInput[]> {
  const batch: MultimodalInput[] = [];
    let boundedTokens = 256; // conservative request framing allowance
    for (const input of inputs) {
      if (input.kind === 'text') { boundedTokens += Buffer.byteLength(input.text, 'utf8'); batch.push(input); }
      else {
        if ((cfg.embed_image_max_pixels ?? 0) === 0) {
          if (tokenCap) throw new AIConfigError('A multimodal request token bound requires image preprocessing; no request sent');
          boundedTokens += Math.ceil(16_000_000 / 560);
          batch.push(input); continue;
        }
        const prepared = await prepareMultimodalImage(Buffer.from(input.data, 'base64'), input.mime, cfg.embed_image_max_pixels ?? 0, signal);
        if (tokenCap && !prepared.variant) throw new AIConfigError('A multimodal request token bound requires image preprocessing; no request sent');
        boundedTokens += prepared.variant ? Math.ceil(prepared.variant.width * prepared.variant.height / 560) : Math.ceil(16_000_000 / 560);
        batch.push({ kind: 'image_base64', data: prepared.bytes.toString('base64'), mime: prepared.mime });
      }
    }
    if (tokenCap && boundedTokens > tokenCap) throw new AIConfigError(`Multimodal request bound ${boundedTokens} exceeds configured ${tokenCap} tokens; input was not truncated and no request sent`);
  return batch;
}

export function multimodalRequestBody(batch: MultimodalInput[], model: string, inputType: string) {
  return {
      inputs: batch.map(input => ({
        // Voyage's documented content shape supports both image and text
        // entries. v0.36 cross-modal: text variant for query embedding.
        content: [
          input.kind === 'text'
            ? { type: 'text', text: input.text }
            : {
              type: 'image_base64',
              image_base64: `data:${input.mime};base64,${input.data}`,
            },
        ],
      })),
      model,
      input_type: inputType,
    };
}

export function multimodalRequestLimits(cfg: AIGatewayConfig) {
  const batchSize = cfg.embed_image_batch_size === undefined || cfg.embed_image_batch_size === 0 ? 32 : cfg.embed_image_batch_size;
  const tokenCap = cfg.embed_image_max_request_tokens ?? 0;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32 || !Number.isSafeInteger(tokenCap) || tokenCap < 0) throw new AIConfigError('Invalid multimodal batch size or request token bound');
  return { batchSize, tokenCap };
}
