/** Fork extensions never allocate, increment or rewrite the upstream config.version. */
import { readForkExtensionStatus } from './status.ts';
import type { BrainEngine } from '../engine.ts';
import { resolveSchemaLockTimeoutMs } from '../postgres-engine/schema-lock-timeout.ts';
import { IMAGE_SPEND_EXTENSION_ID, IMAGE_SPEND_EXTENSION_VERSION, IMAGE_SPEND_EXTENSION_SQL, IMAGE_SPEND_EXTENSION_SHA256, IMAGE_SPEND_GUARD_HASHES } from './managed-image-spend.ts';

export async function applyForkExtensions(engine: BrainEngine): Promise<void> {
  // initSchema already owns its engine schema-init lock. A separate transaction lock
  // serializes direct runMigrations callers without reacquiring the session's key 42.
  await engine.transactionDirect(async tx => {
    if (engine.kind === 'postgres') {
      await tx.executeRaw("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout','60000',true)", [`${resolveSchemaLockTimeoutMs()}ms`]);
      await tx.executeRaw('SELECT pg_advisory_xact_lock($1::bigint)', ['773859112216901']);
    }
    // runMigration's numeric argument is unused by both engines; it executes DDL
    // on this transaction and does not write the official migration version.
    await tx.runMigration(0, `CREATE TABLE IF NOT EXISTS gbrain_fork_migrations (
      id text PRIMARY KEY, version integer NOT NULL CHECK(version>0), ddl_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz NOT NULL DEFAULT now()
    )`);
    const [prior] = await tx.executeRaw<{ version: number; ddl_sha256: string }>('SELECT version,ddl_sha256 FROM gbrain_fork_migrations WHERE id=$1 FOR UPDATE', [IMAGE_SPEND_EXTENSION_ID]);
    if (prior && (prior.version !== IMAGE_SPEND_EXTENSION_VERSION || prior.ddl_sha256 !== IMAGE_SPEND_EXTENSION_SHA256)) {
      throw new Error('fork_extension_drift: managed-image-spend ledger belongs to another extension revision; do not reset the ledger or approved budgets');
    }
    // Existing storage needs only function replacement after a base-schema replay.
    // Do not reacquire request-table ALTER locks on every ordinary CLI init.
    const [status] = await readForkExtensionStatus(tx);
    if (!prior || !status?.storage_match) await tx.runMigration(0, IMAGE_SPEND_EXTENSION_SQL);
    else if (!status.guards_match) {
      for (const guard of IMAGE_SPEND_GUARD_HASHES) {
        const [live] = await tx.executeRaw<{ hash: string }>('SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid=to_regprocedure($1)', [`${guard.name}()`]);
        if (live?.hash !== guard.md5) await tx.runMigration(0, guard.sql);
      }
    }
    await tx.executeRaw(`INSERT INTO gbrain_fork_migrations(id,version,ddl_sha256) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET verified_at=now()`, [IMAGE_SPEND_EXTENSION_ID, IMAGE_SPEND_EXTENSION_VERSION, IMAGE_SPEND_EXTENSION_SHA256]);
  });
}
