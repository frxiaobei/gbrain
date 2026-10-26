/**
 * The approved spend cap of a foreground `gbrain embed` run (fix wave 13
 * P1.18, from PR #6400). Consent returns an Authorization with `cap_usd`; the
 * run spends under a BudgetTracker holding that cap, so every embedding,
 * multimodal and OCR call reserves before it is sent. The first refused
 * reservation aborts the run's signal before the refusal propagates: the
 * page and batch catches see a shutdown, not a chunk failure (no quarantine
 * strike, no per-chunk fan-out), vectors already installed stay banked, and
 * the CLI exits BUDGET_STOP_EXIT_CODE with the command that resumes.
 */
import type { CapSource } from './consent.ts';
import type { BrainEngine } from './engine.ts';
import { createImageSpend, resumeImageSpend, imageSpendTotals, withImageSpend, type ImageSpendTarget, type ImageSpendHandle } from './persistence/image-spend.ts';
import { BudgetExhausted, BudgetTracker, loadPricingOverrides, type PricingOverrides } from './budget/budget-tracker.ts';
import { withBudgetTracker, getEmbeddingModel, getMultimodalModel, getImageOcrModel } from './ai/gateway.ts';
import { shellQuote } from './shell-quote.ts';

export interface EmbedCostCap {
  readonly signal: AbortSignal;
  readonly resuming?: boolean;
  managedAuthorization?(engine: BrainEngine, scope: readonly ImageSpendTarget[]): Promise<ImageSpendHandle>;
  durableTotals?(): Promise<{ authorization_id: string; cap_usd: number; spent_usd: number; unresolved_usd: number } | null>;
  /** The cap's refusal once the run reached it; null while under it. */
  hit(): BudgetExhausted | null;
  metered<T>(fn: () => Promise<T>): Promise<T>;
}

export interface EmbedCostStopFields {
  reason?: string;
  /** The tracker's refusal reason: `cost`, or `no_pricing` (a model with no known price under a user cap). */
  budget_reason?: string;
  cap_usd?: number;
  spent_usd?: number;
  resume_command?: string;
}

/**
 * Null when the authorization carries no finite positive cap (nothing to meter).
 * `pricingOverrides` is the brain's `pricing.overrides` (loadPricingOverrides),
 * so an operator-declared rate prices the run the same way a queued embed job does.
 */
export function embedCostCap(capUsd: number | null | undefined, capSource: CapSource | null | undefined, pricingOverrides?: PricingOverrides, resumeId?: string): EmbedCostCap | null {
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) return null;
  const tracker = new BudgetTracker({ maxCostUsd: capUsd, label: 'embed', ...(capSource ? { capSource } : {}), ...(pricingOverrides ? { pricingOverrides } : {}) });
  const controller = new AbortController();
  let refusal: BudgetExhausted | null = null;
  let durable: { engine: BrainEngine; handle: Promise<ImageSpendHandle> } | undefined;
  // The refusal itself (cost, or a model with no price under a user cap) is kept for the verdict.
  const reserve = tracker.reserve.bind(tracker);
  tracker.reserve = estimate => {
    try { return reserve(estimate); } catch (err) { if (err instanceof BudgetExhausted) refusal ??= err; throw err; }
  };
  tracker.onExhausted(() => controller.abort());
  return {
    signal: controller.signal,
    resuming: !!resumeId,
    hit: () => refusal ?? (controller.signal.aborted
      ? new BudgetExhausted(`embed reached its $${capUsd.toFixed(2)} cost cap`, { reason: 'cost', spent: tracker.totalSpent, cap: capUsd })
      : null),
    managedAuthorization: (engine, scope) => {
      if (durable && durable.engine !== engine) throw new Error('paid_import_budget: one authorization cannot span different brain engines');
      durable ??= { engine, handle: resumeId ? resumeImageSpend(engine, resumeId) : createImageSpend(engine, capUsd, scope, [getEmbeddingModel(), getMultimodalModel() ?? getEmbeddingModel(), ...(process.env.GBRAIN_EMBEDDING_IMAGE_OCR === 'true' ? [getImageOcrModel()] : [])]) };
      return durable.handle;
    },
    durableTotals: async () => {
      if (!durable) return null;
      const handle = await durable.handle;
      return { authorization_id: handle.id, cap_usd: handle.capUsd, ...await imageSpendTotals(durable.engine, handle.id) };
    },
    metered: async fn => {
      const run = () => withBudgetTracker(tracker, fn);
      return durable ? withImageSpend(durable.engine, (await durable.handle).id, run) : run();
    },
  };
}

/**
 * Record the stop on `result`. The resume command is the run itself without
 * its approval flags, so the user approves the rest again: a slug run skips
 * chunks that already have vectors, a stale run picks up where this one stopped.
 */
export function noteEmbedCostStop(result: EmbedCostStopFields, refusal: BudgetExhausted, args: readonly string[]): void {
  const resume: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes' || args[i] === '--json') continue;
    if (args[i] === '--max-usd' || args[i] === '--max-cost') { i++; continue; }
    if (/^--max-(?:usd|cost)=/.test(args[i]!)) continue;
    resume.push(args[i]!);
  }
  result.reason = 'cost_cap';
  result.budget_reason = refusal.reason;
  result.cap_usd = refusal.cap;
  result.spent_usd = refusal.spent;
  result.resume_command = ['gbrain', 'embed', ...resume].map(shellQuote).join(' ');
}

/** The stdout verdict line for a cost-cap stop. */
export function embedCostStopVerdict(result: EmbedCostStopFields, refusal?: BudgetExhausted | null): string {
  const why = result.budget_reason === 'no_pricing' && refusal
    ? refusal.message
    : `the run reached its approved $${result.cap_usd?.toFixed(2)} cost cap after spending $${result.spent_usd?.toFixed(4)}`;
  return `[embed] stopped (reason: cost_cap): ${why}; embeddings already written are kept. `
    + `Resume, after the user approves more spend: ${result.resume_command} --max-usd <usd>`;
}

/** Resume is reuse of an immutable authorization, not another approval. */
export async function resumeEmbedCap(engine: BrainEngine, args: readonly string[]): Promise<ImageSpendHandle | null> {
  const at = args.indexOf('--resume-spend');
  if (at < 0) return null;
  const id = args[at + 1];
  if (!id || !args.includes('--stale') || !args.includes('--images') || args.includes('--background') || args.some(a => /^(--yes|--max-usd|--max-cost)(=|$)/.test(a))) throw new Error('--resume-spend requires --stale --images and no new spend approval flags');
  return resumeImageSpend(engine, id);
}

export async function foregroundEmbedCostCap(engine: BrainEngine, args: readonly string[], authorization: { cap_usd?: number | null; cap_source?: CapSource | null } | null): Promise<EmbedCostCap | null> {
  const resumed = await resumeEmbedCap(engine, args);
  if (args.includes('--dry-run') || args.includes('--background')) return null;
  return embedCostCap(resumed?.capUsd ?? authorization?.cap_usd, resumed ? 'user' : authorization?.cap_source, await loadPricingOverrides(engine), resumed?.id);
}
