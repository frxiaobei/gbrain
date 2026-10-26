import { describe, expect, test } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { managedBrain } from './helpers/managed-brain.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { createImageSpend } from '../src/core/persistence/image-spend.ts';
import { readForkExtensionStatus } from '../src/core/fork-migrations/status.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/shared-skills/persistence-schema.ts';
import { imageSpendTotals, withImageSpend } from '../src/core/persistence/image-spend.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { claimNextWrite } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';

for (const databaseUrl of [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])]) {
  describe(databaseUrl ? 'image budget protocol Postgres' : 'image budget protocol PGLite', () => {
    test('old owner cannot claim; revocation permits cancellation and never loosens scope', () => withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, () => managedBrain(async ({ engine, ctx }) => {
      const auth = await createImageSpend(engine, 0.025, [{ sourceId: 'default', slug: 'image.png' }], ['voyage:voyage-multimodal-3']);
      const binding = (await getWorktreeBinding(engine, 'default'))!;
      const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, 'image.png');
      const admission = { principal: authority.principal, authority, operation: 'put_page' as const, sourceId: 'default', sourceIncarnation: binding.source_incarnation,
        slug: 'image.png', requestId: randomUUID(), callerIntent: { image: true }, intent: { kind: 'managed_file_import' }, worktreeId: binding.worktree_id,
        topologyGeneration: binding.topology_generation, protocolVersion: 3 as const, spendAuthorizationId: auth.id };
      const row = await admitWrite(engine, admission);
      await expect(engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true),set_config('gbrain.paid_import_protocol','',true)");
        await tx.executeRaw("UPDATE persistence_requests SET state='running' WHERE id=$1::uuid", [row.id]);
      })).rejects.toThrow('upgraded owner required');
      await expect(admitWrite(engine, { ...admission, requestId: randomUUID(), slug: 'other.png' })).rejects.toThrow('authorization binding');
      expect(await engine.getConfig('version')).toBe('262');
      expect((await readForkExtensionStatus(engine))[0]!.state).toBe('applied');
      await withImageSpend(engine, auth.id, () => invokeAI({ operation: 'fixture', kind: 'multimodal', model: 'voyage:voyage-multimodal-3', maxInputTokens: 9000, maxOutputTokens: 0 }, async () => 'ok', () => ({ inputTokens: 100, outputTokens: 0 })));
      const spend = await imageSpendTotals(engine, auth.id);
      await engine.runMigration(0, SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(sql => sql.includes('FUNCTION gbrain_guard_request_protocol()'))!);
      const ledgerBefore = await engine.executeRaw('SELECT id,version,ddl_sha256,verified_at::text FROM gbrain_fork_migrations');
      expect((await readForkExtensionStatus(engine))[0]!.state).toBe('drift');
      expect(await hasPendingMigrations(engine)).toBe(true);
      expect(await engine.executeRaw('SELECT id,version,ddl_sha256,verified_at::text FROM gbrain_fork_migrations')).toEqual(ledgerBefore);
      await engine.initSchema();
      expect((await readForkExtensionStatus(engine))[0]!.state).toBe('applied');
      expect(await hasPendingMigrations(engine)).toBe(false);
      expect(await engine.getConfig('version')).toBe('262');
      expect(await imageSpendTotals(engine, auth.id)).toEqual(spend);
      // The upstream-owned number is still available and its function really installs.
      await engine.runMigration(263, readFileSync(new URL('./fixtures/official-v263-try-jsonb.sql', import.meta.url), 'utf8'));
      await engine.setConfig('version', '263');
      await engine.initSchema();
      expect(await engine.getConfig('version')).toBe('263');
      expect((await engine.executeRaw<{ value: unknown }>(`SELECT gbrain_try_jsonb('{"ok":true}') AS value`))[0]!.value).toEqual({ ok: true });
      expect(await imageSpendTotals(engine, auth.id)).toEqual(spend);
      const claimed = await claimNextWrite(engine, binding.owner_host_id!);
      expect(claimed?.id).toBe(row.id); expect(claimed?.spend_authorization_id).toBe(auth.id);

      await engine.executeRaw('UPDATE persistence_spend_authorizations SET revoked=true WHERE id=$1::uuid', [auth.id]);
      await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_requests SET state='cancelled' WHERE id=$1::uuid", [row.id]); });
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [row.id]))[0]!.state).toBe('cancelled');
    }, { databaseUrl })), 120_000);
  });
}
