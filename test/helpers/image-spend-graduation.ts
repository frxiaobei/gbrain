/** Synthetic immutable approval and two priced attempts for copier regression; no provider calls. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { reserveGroup, settle } from '../../src/core/minions/budget-meter.ts';
export async function seedImageSpendGraduation(engine: BrainEngine, priorRequestId: string, authId: string, requestId: string): Promise<void> {
  // A finished paid image and an unresolved attempt must retain their original approval.
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('session_replication_role','replica',true)");
    await tx.executeRaw(`INSERT INTO persistence_spend_authorizations(id,principal_kind,principal_id,cap_cents,scope,models)
      SELECT $1::uuid,principal_kind,principal_id,2.5,jsonb_build_array(jsonb_build_object('sourceId',source_id,'slug',slug)),
        '["voyage:voyage-multimodal-3"]'::jsonb FROM persistence_requests WHERE request_id=$2::uuid`, [authId, priorRequestId]);
    await tx.executeRaw(`INSERT INTO persistence_requests SELECT (jsonb_populate_record(NULL::persistence_requests,to_jsonb(r)||jsonb_build_object(
      'id',$1::text,'request_id',$1::text,'sequence',nextval(pg_get_serial_sequence('persistence_requests','sequence')),'protocol_version',3,'spend_authorization_id',$2::text,
      'intent',jsonb_build_object('kind','managed_file_import'),'created_at',now()-interval '1 day'))).* FROM persistence_requests r WHERE request_id=$3::uuid`,
      [requestId, authId, priorRequestId]);
  });
  const settled = await reserveGroup(engine, { budgetKey: `image-cap:${authId}`, capCents: 2.5, estimatedCents: .1, estimateKnown: true, strict: true, model: 'voyage:voyage-multimodal-3', provider: 'voyage' });
  await settle(engine, settled.reservationId, .05, 'fixture');
  await reserveGroup(engine, { budgetKey: `image-cap:${authId}`, capCents: 2.5, estimatedCents: .2, estimateKnown: true, strict: true, model: 'voyage:voyage-multimodal-3', provider: 'voyage' });
  await engine.executeRaw("UPDATE mcp_spend_reservations SET write_request_id=$2::uuid,usage_unknown_reason=CASE WHEN status='pending' THEN 'response_lost' ELSE NULL END WHERE budget_key=$1", [`image-cap:${authId}`, requestId]);
  await engine.executeRaw("UPDATE gbrain_fork_migrations SET verified_at='2000-01-01'::timestamptz");
}
