import type { GBrainConfig } from '../config.ts';
export async function mergeImageControls(file: GBrainConfig, read: (key: string) => Promise<string | undefined>): Promise<GBrainConfig> {
  const merged = { ...file };
  for (const name of ['image_min_interval_ms', 'image_max_pixels', 'image_max_request_tokens', 'image_batch_size'] as const) {
    const field = `embed_${name}` as const;
    if (merged[field] === undefined) { const value = await read(`embed.${name}`); if (value !== undefined) merged[field] = Number(value); }
  }
  return merged;
}

// The gateway supplies a read-only view without making persistence depend on it.
type ImageControlView = Pick<GBrainConfig, 'embed_image_min_interval_ms' | 'embed_image_max_pixels'>;
let readCurrent: () => ImageControlView | null = () => null;
export function registerImageControlReader(reader: () => ImageControlView | null): void { readCurrent = reader; }
export function currentImageMinInterval(): number { return readCurrent()?.embed_image_min_interval_ms ?? 0; }
export function currentImageMaxPixels(): number { return readCurrent()?.embed_image_max_pixels ?? 0; }
