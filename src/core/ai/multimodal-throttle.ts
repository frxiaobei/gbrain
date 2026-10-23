/** Host/config-directory shared provider pacing; no DB transaction is held. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configDir } from '../config.ts';
import { acquireNativeLock, type NativeLockHandle } from '../persistence/native-lock.ts';
import { AIConfigError } from './errors.ts';

interface PermitState { version: 1; recordedAt: number; nextAllowedAt: number }
interface AdmittedPermit { intervalMs: number; directory: string; lock: NativeLockHandle; consumed: boolean }
const admitted = new AsyncLocalStorage<AdmittedPermit>();
const providerDirectory = () => join(configDir(), 'provider-state', 'voyage-multimodal');
function validateInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) throw new AIConfigError('embed.image_min_interval_ms must be an integer from 0 to 2147483647');
}
async function remainingPermit(path: string): Promise<number> {
  let state: PermitState | undefined;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AIConfigError('Voyage pacing state is unreadable; no request sent', undefined, error); }
  if (state !== undefined && (!state || typeof state !== 'object' || state.version !== 1 || !Number.isSafeInteger(state.recordedAt) || !Number.isSafeInteger(state.nextAllowedAt) || state.nextAllowedAt < state.recordedAt)) throw new AIConfigError('Voyage pacing state is invalid; no request sent');
  if (state && Date.now() < state.recordedAt) throw new AIConfigError('Host clock moved backwards since the last Voyage request; no request sent');
  return state ? Math.max(0, state.nextAllowedAt - Date.now()) : 0;
}
/** Owner admission runs before the preparation clock; never waits or sends. */
export async function tryAdmitMultimodal(intervalMs: number, signal?: AbortSignal): Promise<
  { ready: false; retryAfterMs: number } | { ready: true; run: <T>(work: () => Promise<T>) => Promise<T> }> {
  validateInterval(intervalMs);
  if (intervalMs === 0) return { ready: true, run: work => work() };
  const directory = providerDirectory();
  const lock = await acquireNativeLock(join(directory, 'request.lock'), { timeoutMs: 0, signal });
  if (!lock) return { ready: false, retryAfterMs: 1000 };
  try {
    const wait = await remainingPermit(join(directory, 'permit.json'));
    if (wait > 0) { await lock.release(); return { ready: false, retryAfterMs: Math.min(wait, 1000) }; }
    return { ready: true, run: async work => {
      try { signal?.throwIfAborted(); return await admitted.run({ intervalMs, directory, lock, consumed: false }, work); }
      finally { await lock.release(); }
    } };
  } catch (error) { await lock.release(); throw error; }
}
export async function withMultimodalPermit<T>(intervalMs: number, requestTimeoutMs: number, signal: AbortSignal | undefined,
  send: () => Promise<T>, directory = providerDirectory()): Promise<T> {
  validateInterval(intervalMs);
  signal?.throwIfAborted();
  if (intervalMs === 0) return send();
  const prior = admitted.getStore();
  const reuse = prior && !prior.consumed && !prior.lock.released && prior.directory === directory;
  if (reuse) {
    prior.consumed = true;
    if (prior.intervalMs !== intervalMs) throw new AIConfigError('Provider pacing configuration changed after owner admission; no request sent');
  }
  const lock = reuse ? prior.lock : await acquireNativeLock(join(directory, 'request.lock'), { timeoutMs: 300_000, signal });
  if (!lock) throw new AIConfigError('Voyage multimodal pacing lock timed out; no request sent');
  const path = join(directory, 'permit.json');
  const persist = async (state: PermitState) => {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  };
  try {
    const remaining = await remainingPermit(path);
    if (remaining > 0) await delay(remaining, undefined, { signal });
    signal?.throwIfAborted();
    const startedAt = Date.now();
    await persist({ version: 1, recordedAt: startedAt, nextAllowedAt: startedAt + requestTimeoutMs + intervalMs });
    signal?.throwIfAborted();
    try { return await send(); }
    finally { const endedAt = Date.now(); await persist({ version: 1, recordedAt: endedAt, nextAllowedAt: endedAt + intervalMs }); }
  } finally { await lock.release(); }
}
