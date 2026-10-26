/** Trusted, lifetime spend authorization shared by an embed caller and durable image owners. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { Principal, WriteRequest } from './model.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { withAIInvocationGuard, withAIInvocationPreflight } from '../ai/invocation-guard.ts';
import { maximumInvocationCents, actualCents } from '../minions/delegated-spend.ts';
import { reserveGroup, settle, readGroupSpend, GroupBudgetRefusal } from '../minions/budget-meter.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { overrideFor } from '../budget/reservation-cost.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { opError } from '../ops/contract.ts';

export interface ImageSpendTarget { readonly sourceId: string; readonly slug: string }
export interface ImageSpendHandle { readonly id: string; readonly capUsd: number; readonly scope: readonly ImageSpendTarget[] }
const trusted = new WeakSet<object>();
const active = new AsyncLocalStorage<{ engine: BrainEngine; id: string }>();
const refusal = (message: string) => opError('invalid_params', `paid_import_budget: ${message}`, 'Keep the approved cap. Inspect the original write request and its budget; do not retry through an uncapped import.');
const ceilCents = (value: number) => Math.ceil(value * 10_000) / 10_000;
export function assertImageSpendHandle(value: ImageSpendHandle): void {
  if (!trusted.has(value)) throw refusal('untrusted authorization handle; nothing was admitted');
}
/** The DB unit is 1e-4 cents. Never round the approved amount upward. */
export function strictCapCents(usd: number): number {
  const value = Math.floor(usd * 1_000_000) / 10_000;
  if (!Number.isFinite(value) || value <= 0 || value >= 100_000_000) throw refusal('cap must be finite, positive and representable');
  return value;
}
export async function createImageSpend(engine: BrainEngine, capUsd: number, scope: readonly ImageSpendTarget[], models: readonly string[]): Promise<ImageSpendHandle> {
  const caller = currentSubmissionAuthority();
  const verified = currentVerifiedLocalWriter();
  if (caller || verified?.remote || (verified && verified.principal.kind !== 'local_cli')) throw refusal('only the consent-gated local CLI can authorize image spend');
  const principal: Principal = verified?.principal ?? { kind: 'local_cli', id: (await registerLocalWriter(engine, 'cli')).id };
  if (!scope.length || scope.some(t => !t.sourceId || !t.slug)) throw refusal('an exact nonempty image scope is required');
  if (!models.length || models.some(model => !model.includes(':'))) throw refusal('explicit provider/model IDs are required');
  const id = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_spend_authorizations(id,principal_kind,principal_id,cap_cents,scope,models)
    VALUES($1::uuid,$2,$3,$4,$5::text::jsonb,$6::text::jsonb)`, [id, principal.kind, principal.id, strictCapCents(capUsd), JSON.stringify(scope), JSON.stringify([...new Set(models)].sort())]);
  const handle = Object.freeze({ id, capUsd, scope: Object.freeze(scope.map(t => Object.freeze({ ...t }))) }); trusted.add(handle); return handle;
}
/** Resume preserves the original immutable cap and scope; never creates or replenishes a group. */
export async function resumeImageSpend(engine: BrainEngine, id: string, scope?: readonly ImageSpendTarget[]): Promise<ImageSpendHandle> {
  const verified = currentVerifiedLocalWriter();
  if (currentSubmissionAuthority() || verified?.remote || (verified && verified.principal.kind !== 'local_cli')) throw refusal('resume requires the original local CLI principal');
  const principalId = verified?.principal.id ?? (await registerLocalWriter(engine, 'cli')).id;
  const [auth] = await engine.executeRaw<{ cap_cents: string; scope: ImageSpendTarget[] }>(
    "SELECT cap_cents::text,scope FROM persistence_spend_authorizations WHERE id=$1::uuid AND principal_kind='local_cli' AND principal_id=$2 AND NOT revoked", [id, principalId]);
  if (!auth) throw refusal('original authorization is missing, revoked or belongs to another principal');
  if (scope?.some(t => !auth.scope.some(original => original.sourceId === t.sourceId && original.slug === t.slug))) throw refusal('resume candidates extend beyond the original image scope');
  const handle = Object.freeze({ id, capUsd: Number(auth.cap_cents) / 100, scope: Object.freeze(auth.scope.map(t => Object.freeze({ ...t }))) }); trusted.add(handle); return handle;
}

export async function imageSpendTotals(engine: BrainEngine, id: string) {
  const spend = await readGroupSpend(engine, `image-cap:${id}`);
  return { spent_usd: spend.committedCents / 100, unresolved_usd: (spend.liveCents + spend.overdueCents) / 100 };
}
/** Every actual provider attempt reserves full liability; unknown outcomes never refund it. */
export async function withImageSpend<T>(engine: BrainEngine, id: string, run: () => Promise<T>, row?: WriteRequest): Promise<T> {
  const pricing = await loadPricingOverrides(engine);
  const read = async (tx: BrainEngine) => {
    const [auth] = await tx.executeRaw<{ cap_cents: string; revoked: boolean; principal_kind: string; principal_id: string; scope: ImageSpendTarget[]; models: string[] }>(
      'SELECT cap_cents::text,revoked,principal_kind,principal_id,scope,models FROM persistence_spend_authorizations WHERE id=$1::uuid', [id]);
    if (!auth || auth.revoked || (row && (auth.principal_kind !== row.principal_kind || auth.principal_id !== row.principal_id))) throw refusal('authorization is missing, revoked or belongs to another principal');
    if (row && !auth.scope.some(t => t.sourceId === row.source_id && t.slug === row.slug)) throw refusal('request lies outside the approved image scope');
    if (row) {
      const live = await tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid AND state=\'running\' AND execution_token=$2 AND spend_authorization_id=$3::uuid', [row.id, row.execution_token, id]);
      if (!live.length) throw refusal('the owner claim is no longer current');
    }
    const cap = Number(auth.cap_cents); if (!Number.isFinite(cap) || cap <= 0) throw refusal('invalid stored cap');
    return { cap, models: auth.models };
  };
  const { cap, models } = await read(engine);
  if (active.getStore()?.engine === engine && active.getStore()?.id === id) return withAIInvocationPreflight(async () => { await read(engine); }, run);
  return active.run({ engine, id }, () => withAIInvocationGuard(async call => {
    if (!models.includes(call.model)) throw refusal(`model ${call.model} is outside the original provider/model authorization`);
    // Multimodal embedding uses the embedding price table, not chat pricing.
    const known = call.kind === 'multimodal' ? lookupEmbeddingPrice(call.model) : null;
    const rate = call.kind === 'multimodal' ? overrideFor(call.model, pricing)?.input ?? (known?.kind === 'known' ? known.pricePerMTok : null) : null;
    const maximum = call.kind === 'multimodal'
      ? rate !== null && Number.isSafeInteger(call.maxInputTokens) && call.maxInputTokens! >= 0 && call.maxOutputTokens === 0
        ? call.maxInputTokens! * rate / 10_000 : null
      : maximumInvocationCents(call, pricing);
    if (maximum === null) throw refusal(`no proven input/output price bound for ${call.model}; no provider call sent`);
    const hold = await reserveGroup(engine, { budgetKey: `image-cap:${id}`, capCents: cap,
      estimatedCents: ceilCents(maximum), estimateKnown: true, strict: true, model: call.model,
      provider: call.model.split(':')[0]!, validateAdmission: async tx => { await read(tx); } }).catch(error => { if (error instanceof GroupBudgetRefusal) throw refusal(error.message); throw error; });
    if (row) await engine.executeRaw('UPDATE mcp_spend_reservations SET write_request_id=$2::uuid WHERE reservation_id=$1', [hold.reservationId, row.request_id]);
    return { async settle(usage) {
      const amount = call.kind === 'multimodal'
        ? rate !== null && usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0 && usage.outputTokens === 0
          ? usage.inputTokens * rate / 10_000 : null
        : actualCents(call, usage, pricing);
      if (amount !== null) await settle(engine, hold.reservationId, ceilCents(amount), call.operation);
      else await engine.executeRaw(`UPDATE mcp_spend_reservations SET usage_unknown_reason='provider_usage_unknown'
        WHERE reservation_id=$1 AND status IN ('pending','expired')`, [hold.reservationId]);
    } };
  }, run, { inherit: true }));
}
