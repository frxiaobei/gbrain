/** Real independent processes share a lifetime image cap; all HTTP stays on localhost. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { join, resolve } from 'node:path';
import { PostgresEngine } from 'gbrain';
import { createImageSpend, imageSpendTotals, resumeImageSpend } from '../../src/core/persistence/image-spend.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { runCli } from '../helpers/cli-spawn.ts';
import { applyForkExtensions } from '../../src/core/fork-migrations/runner.ts';
import { readForkExtensionStatus } from '../../src/core/fork-migrations/status.ts';
import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../../src/core/shared-skills/persistence-schema.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
const databaseUrl = process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('durable image spend across processes', () => {
  let engine: PostgresEngine;
  let testDbUrl: string;
  let closeDatabase: (() => Promise<void>) | undefined;
  let directory: string;
  let worker: string;
  let requests = 0;
  const originalHome = process.env.GBRAIN_HOME;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'gbrain-image-budget-process-')));
    process.env.GBRAIN_HOME = directory;
    assertSafeE2eDatabaseUrl(databaseUrl!);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { requests++; return Response.json({ tokens: 9000 }); } });
    const isolated = await isolatedPersistencePostgres(databaseUrl!); engine = isolated.engine; testDbUrl = isolated.databaseUrl; closeDatabase = isolated.close;
    worker = join(directory, 'worker.ts');
    await writeFile(worker, `
      import { PostgresEngine } from ${JSON.stringify(resolve('src/core/postgres-engine.ts'))};
      import { withImageSpend } from ${JSON.stringify(resolve('src/core/persistence/image-spend.ts'))};
      import { invokeAI } from ${JSON.stringify(resolve('src/core/ai/invocation-guard.ts'))};
      const engine = new PostgresEngine(); await engine.connect({database_url:process.env.DATABASE_URL,poolSize:2});
      try {
        await withImageSpend(engine, process.argv[2], () => invokeAI({operation:'gateway.multimodal',kind:'multimodal',model:process.argv[5]||'voyage:voyage-multimodal-3',maxInputTokens:9000,maxOutputTokens:0},
          async () => { const r=await fetch(process.argv[3]); if(process.argv[4]==='crash') process.kill(process.pid,'SIGKILL'); if(process.argv[4]==='unknown') throw new Error('response lost'); return r.json(); },
          result => ({inputTokens:result.tokens,outputTokens:0})));
        console.log('admitted');
      } catch(e) { console.log('refused:'+String(e)); }
      finally { await engine.disconnect(); }
    `);
  }, 120_000);
  afterAll(async () => { server?.stop(true); await closeDatabase?.(); if (directory) await rm(directory, { recursive: true, force: true }); if (originalHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = originalHome; });
  async function attempt(id: string, unknown = false, model = 'voyage:voyage-multimodal-3') {
    const process = Bun.spawn([Bun.which('bun')!, worker, id, server.url.toString(), unknown ? 'unknown' : 'known', model], { env: { ...Bun.env, DATABASE_URL: testDbUrl }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit).toBe(0); expect(err).toBe(''); return out;
  }
  test('two callers cannot jointly exceed exact .002 cap and restarting keeps the same remainder', async () => {
    const auth = await createImageSpend(engine, 0.002, [{ sourceId: 'default', slug: 'image.png' }], ['voyage:voyage-multimodal-3']);
    const before = requests;
    const outcomes = await Promise.all([attempt(auth.id), attempt(auth.id)]);
    expect(outcomes.filter(s => s.trim() === 'admitted')).toHaveLength(1);
    expect(requests - before).toBe(1);
    expect((await imageSpendTotals(engine, auth.id)).spent_usd).toBe(0.00108);
    expect((await resumeImageSpend(engine, auth.id)).capUsd).toBe(0.002);
    expect(await attempt(auth.id)).toContain('paid_import_budget');
    expect(requests - before).toBe(1);
  }, 30_000);
  test.skipIf(process.platform !== 'darwin')('a separate durable owner claims the bound request and meters its actual image preparation', async () => {
    const root = join(directory, 'brain'); await (await import('node:fs/promises')).mkdir(root);
    execFileSync('git', ['init', '-q', root]);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const file = join(root, 'image.png'); await writeFile(file, bytes);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const binding = (await getWorktreeBinding(engine, 'default'))!;
    const auth = await createImageSpend(engine, 0.025, [{ sourceId: 'default', slug: 'image.png' }], ['voyage:voyage-multimodal-3']);
    const authority = await submissionAuthority({ engine, config: { engine: 'postgres' }, remote: false } as never, 'put_page', 'default', binding.source_incarnation, 'image.png');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
      slug: 'image.png', requestId: randomUUID(), callerIntent: { fixture: true }, intent: { kind: 'managed_file_import', content: bytes.toString('base64'), slug: 'image.png', sourcePath: 'image.png', inputPath: file, inputHash: hash, targetHash: hash, ownerEpoch: String(binding.owner_epoch), noEmbed: false },
      worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, protocolVersion: 3, spendAuthorizationId: auth.id });
    const owner = join(directory, 'owner.ts');
    await writeFile(owner, `
      import { PostgresEngine } from ${JSON.stringify(resolve('src/core/postgres-engine.ts'))};
      import { claimNextWrite } from ${JSON.stringify(resolve('src/core/persistence/journal.ts'))};
      import { localHostId } from ${JSON.stringify(resolve('src/core/persistence/identity.ts'))};
      import { preparePersistedMutation } from ${JSON.stringify(resolve('src/core/persistence/service.ts'))};
      import { configureGateway } from ${JSON.stringify(resolve('src/core/ai/gateway.ts'))};
      const engine=new PostgresEngine(); await engine.connect({database_url:process.env.DATABASE_URL,poolSize:4});
      configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_multimodal_model:'voyage:voyage-multimodal-3',embedding_dimensions:1536,embed_image_max_pixels:4000000,embed_image_max_request_tokens:9000,env:{VOYAGE_API_KEY:'test-key'}});
      globalThis.fetch=async()=>new Response(JSON.stringify({data:[{embedding:Array(1024).fill(.1),index:0}],usage:{total_tokens:123},model:'voyage-multimodal-3'}),{headers:{'Content-Type':'application/json'}});
      try {const row=await claimNextWrite(engine,localHostId()); if(!row)throw Error('no claim'); const prepared=await preparePersistedMutation(engine,row,{engine:'postgres'}); console.log(JSON.stringify({id:row.id,deferEmbedding:prepared.deferEmbedding}));}
      finally {await engine.disconnect();}
    `);
    const child = Bun.spawn([Bun.which('bun')!, owner], { env: { ...Bun.env, DATABASE_URL: testDbUrl, GBRAIN_HOME: directory, GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' }, stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: '' }); expect(JSON.parse(output)).toEqual({ id: row.id, deferEmbedding: true });
    expect((await imageSpendTotals(engine, auth.id)).spent_usd).toBe(0.000015);
    const reservations = await engine.executeRaw<{ write_request_id: string }>('SELECT write_request_id FROM mcp_spend_reservations WHERE budget_key=$1', [`image-cap:${auth.id}`]);
    expect(reservations[0]!.write_request_id).toBe(row.request_id);
  }, 60_000);
  test('provider/model drift refuses before HTTP and process death retains its liability', async () => {
    const auth = await createImageSpend(engine, 0.002, [{ sourceId: 'default', slug: 'image.png' }], ['voyage:voyage-multimodal-3']);
    const before = requests;
    expect(await attempt(auth.id, false, 'openai:text-embedding-3-small')).toContain('outside the original provider/model');
    expect(requests).toBe(before);
    const child = Bun.spawn([Bun.which('bun')!, worker, auth.id, server.url.toString(), 'crash'], { env: { ...Bun.env, DATABASE_URL: testDbUrl }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).not.toBe(0);
    expect(requests - before).toBe(1);
    expect((await imageSpendTotals(engine, auth.id)).unresolved_usd).toBe(0.00108);
    expect(await attempt(auth.id)).toContain('paid_import_budget');
    expect(requests - before).toBe(1);
  }, 30_000);
  test('unknown response stays charged after expiry and another process refuses', async () => {
    const auth = await createImageSpend(engine, 0.002, [{ sourceId: 'default', slug: 'image.png' }], ['voyage:voyage-multimodal-3']);
    const before = requests;
    expect(await attempt(auth.id, true)).toContain('response lost');
    await engine.executeRaw("UPDATE mcp_spend_reservations SET expires_at=now()-interval '1 day' WHERE budget_key=$1", [`image-cap:${auth.id}`]);
    expect((await imageSpendTotals(engine, auth.id)).unresolved_usd).toBe(0.00108);
    expect(await attempt(auth.id)).toContain('paid_import_budget');
    expect(requests - before).toBe(1);
  }, 30_000);
  test('guard repair does not take request-table ALTER locks while another writer holds its transaction', async () => {
    await engine.runMigration(0, SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(sql => sql.includes('FUNCTION gbrain_guard_request_protocol()'))!);
    let acquired!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const writer = engine.transactionDirect(async tx => {
      await tx.executeRaw('LOCK TABLE persistence_requests IN ROW EXCLUSIVE MODE');
      acquired(); await held;
    });
    await ready;
    try {
      await applyForkExtensions(engine);
      expect((await readForkExtensionStatus(engine))[0]!.state).toBe('applied');
    } finally { release(); await writer; }
  }, 15_000);
  test('official list and dry-run report a drifted extension without executing any DDL', async () => {
    await (await import('node:fs/promises')).mkdir(join(directory, '.gbrain'), { recursive: true });
    await writeFile(join(directory, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: testDbUrl, embedding_disabled: true }));
    await engine.runMigration(0, SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(sql => sql.includes('FUNCTION gbrain_guard_request_protocol()'))!);
    await engine.runMigration(0, `CREATE TABLE fork_test_ddl_audit(tag text);
      CREATE FUNCTION fork_test_ddl_audit() RETURNS event_trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN INSERT INTO fork_test_ddl_audit VALUES(TG_TAG); END $$;
      CREATE EVENT TRIGGER fork_test_ddl_audit ON ddl_command_end EXECUTE FUNCTION fork_test_ddl_audit();`);
    const count = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM fork_test_ddl_audit'))[0]!.n);
    const before = await count();
    for (const flag of ['--list', '--dry-run']) {
      const result = await runCli(['apply-migrations', flag, '--json', '--require-db'], { home: directory, env: { GBRAIN_DATABASE_URL: testDbUrl } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).database.fork_extensions[0].state).toBe('drift');
      expect(await count()).toBe(before);
      expect((await readForkExtensionStatus(engine))[0]!.state).toBe('drift');
    }
    // A missing ledger is also a read-only pending result, never an implicit install.
    await engine.runMigration(0, 'DROP TABLE gbrain_fork_migrations');
    const missingBefore = await count();
    for (const flag of ['--list', '--dry-run']) {
      const result = await runCli(['apply-migrations', flag, '--json', '--require-db'], { home: directory, env: { GBRAIN_DATABASE_URL: testDbUrl } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).database.fork_extensions[0].state).toBe('pending');
      expect(await count()).toBe(missingBefore);
    }
    const configBefore = await engine.getConfig('version');
    const result = await runCli(['init', '--migrate-only', '--json'], { home: directory, env: { GBRAIN_DATABASE_URL: testDbUrl } });
    expect(result.exitCode).toBe(0);
    expect((await readForkExtensionStatus(engine))[0]!.state).toBe('applied');
    expect(await engine.getConfig('version')).toBe(configBefore);
  }, 60_000);

});
