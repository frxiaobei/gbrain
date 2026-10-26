/** Read-only extension inventory. A matching ledger alone never proves a live guard. */
import type { BrainEngine } from '../engine.ts';
import { IMAGE_SPEND_EXTENSION_ID, IMAGE_SPEND_EXTENSION_VERSION, IMAGE_SPEND_EXTENSION_SHA256, IMAGE_SPEND_GUARD_HASHES } from './managed-image-spend.ts';
export interface ForkExtensionStatus {
  id: string; version: number; expected_sha256: string; applied_version: number | null;
  applied_sha256: string | null; guards_match: boolean; storage_match: boolean; state: 'pending' | 'applied' | 'drift';
}
export async function readForkExtensionStatus(engine: Pick<BrainEngine, 'executeRaw'>): Promise<ForkExtensionStatus[]> {
  const [probe] = await engine.executeRaw<{ ledger: boolean; storage: boolean; guard_count: number }>(`SELECT
    to_regclass('gbrain_fork_migrations') IS NOT NULL AS ledger,
    to_regclass('persistence_spend_authorizations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='persistence_requests' AND column_name='spend_authorization_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='mcp_spend_reservations' AND column_name='write_request_id')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('persistence_requests') AND conname='persistence_requests_protocol_version_check'
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')='CHECK((protocol_version=ANY(ARRAY[1,2,3])))')
      AND (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND
        ((t.tgrelid=to_regclass('persistence_requests') AND t.tgname='gbrain_request_protocol' AND p.proname='gbrain_guard_request_protocol' AND t.tgtype=31)
        OR (t.tgrelid=to_regclass('persistence_spend_authorizations') AND t.tgname='gbrain_spend_authorization_immutable' AND p.proname='gbrain_guard_spend_authorization' AND t.tgtype=27)))=2 AS storage,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN unnest($1::text[],$2::text[]) AS expected(name,hash) ON expected.name=p.proname AND expected.hash=md5(p.prosrc)
      WHERE n.nspname=current_schema() AND p.pronargs=0) AS guard_count`,
    [IMAGE_SPEND_GUARD_HASHES.map(g => g.name), IMAGE_SPEND_GUARD_HASHES.map(g => g.md5)]);
  const [row] = probe?.ledger ? await engine.executeRaw<{ version: number; ddl_sha256: string }>(
    'SELECT version,ddl_sha256 FROM gbrain_fork_migrations WHERE id=$1', [IMAGE_SPEND_EXTENSION_ID]) : [];
  const guards = probe?.storage === true && probe.guard_count === IMAGE_SPEND_GUARD_HASHES.length;
  return [{ id: IMAGE_SPEND_EXTENSION_ID, version: IMAGE_SPEND_EXTENSION_VERSION, expected_sha256: IMAGE_SPEND_EXTENSION_SHA256,
    applied_version: row?.version ?? null, applied_sha256: row?.ddl_sha256 ?? null, guards_match: guards, storage_match: probe?.storage === true,
    state: !row ? 'pending' : row.version === IMAGE_SPEND_EXTENSION_VERSION && row.ddl_sha256 === IMAGE_SPEND_EXTENSION_SHA256 && guards ? 'applied' : 'drift' }];
}

/** Target emptiness may exempt only this engine's verified capability rows, never approvals or unknown ledger rows. */
export async function installedForkLedgerOnly(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
  const states = await readForkExtensionStatus(engine);
  if (states.some(state => state.state !== 'applied')) return false;
  const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM gbrain_fork_migrations');
  return row?.n === states.length;
}
