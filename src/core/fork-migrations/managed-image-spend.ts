/** Private fork extension: deliberately outside upstream's numbered migration registry. */
import { createHash } from 'node:crypto';
export const IMAGE_SPEND_EXTENSION_ID = 'frxiaobei/managed-image-spend';
export const IMAGE_SPEND_EXTENSION_VERSION = 1;
export const IMAGE_SPEND_EXTENSION_SQL = `
CREATE TABLE IF NOT EXISTS persistence_spend_authorizations (
    id uuid PRIMARY KEY,
    principal_kind text NOT NULL CHECK (principal_kind='local_cli'),
    principal_id text NOT NULL,
    cap_cents numeric(12,4) NOT NULL CHECK (cap_cents>0),
    scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='array'),
    models jsonb NOT NULL CHECK (jsonb_typeof(models)='array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked boolean NOT NULL DEFAULT false
  );
ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS spend_authorization_id uuid REFERENCES persistence_spend_authorizations(id);
ALTER TABLE mcp_spend_reservations ADD COLUMN IF NOT EXISTS write_request_id uuid;
CREATE OR REPLACE FUNCTION gbrain_guard_spend_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.principal_kind<>OLD.principal_kind OR NEW.principal_id<>OLD.principal_id
    OR NEW.models IS DISTINCT FROM OLD.models OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.cap_cents<>OLD.cap_cents OR NEW.created_at<>OLD.created_at OR (OLD.revoked AND NOT NEW.revoked) THEN
    RAISE EXCEPTION 'paid_import_budget: authorization is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gbrain_spend_authorization_immutable ON persistence_spend_authorizations;
CREATE TRIGGER gbrain_spend_authorization_immutable BEFORE UPDATE OR DELETE ON persistence_spend_authorizations
  FOR EACH ROW EXECUTE FUNCTION gbrain_guard_spend_authorization();

ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_protocol_version_check;
ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_protocol_version_check CHECK(protocol_version IN (1,2,3));
CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
  DECLARE target text; version integer; floor integer; active boolean; record jsonb;
  BEGIN
    IF TG_OP='DELETE' THEN target:=OLD.target_kind; version:=OLD.protocol_version;
    ELSE target:=NEW.target_kind; version:=NEW.protocol_version; END IF;
    SELECT writer_protocol_floor,skill_bundles_enabled INTO floor,active FROM persistence_brain WHERE singleton=1 FOR SHARE;
    PERFORM gbrain_require_persistence_protocol(GREATEST(floor,CASE WHEN version=3 THEN 1 ELSE version END,CASE WHEN target='skill_bundle' THEN 2 ELSE 1 END));
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND (NEW.target_kind<>OLD.target_kind OR NEW.protocol_version<>OLD.protocol_version) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: a request target is immutable' USING ERRCODE='42501';
    END IF;
    IF NEW.operation IN ('put_skill','delete_skill','adopt_skillpack') AND target<>'skill_bundle' THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: skill operations require a typed target' USING ERRCODE='42501';
    END IF;
    IF target='skill_bundle' THEN
      IF version<>2 OR NEW.page_id IS NOT NULL OR NEW.worktree_id IS NULL THEN
        RAISE EXCEPTION 'unsupported_mutation_protocol: invalid skill target' USING ERRCODE='42501';
      END IF;
      IF TG_OP='INSERT' AND NOT active THEN
        RAISE EXCEPTION 'writer_not_quiesced: shared publication is disabled' USING ERRCODE='42501';
      END IF;
      IF (TG_OP='INSERT' OR (NEW.state='running' AND OLD.state IS DISTINCT FROM 'running')) AND NOT EXISTS (SELECT 1 FROM persistence_worktrees w JOIN persistence_writer_protocols p
        ON p.worktree_id=w.id AND p.host_id=w.owner_host_id AND p.owner_epoch=w.owner_epoch AND p.protocol_version=2
        WHERE w.id=NEW.worktree_id AND w.state='active') THEN
        RAISE EXCEPTION 'writer_not_quiesced: canonical owner capability must be revalidated' USING ERRCODE='42501';
      END IF;
    ELSIF version=3 THEN
      IF NEW.operation<>'put_page' OR NEW.intent->>'kind' IS DISTINCT FROM 'managed_file_import' OR NEW.spend_authorization_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM persistence_spend_authorizations a WHERE a.id=NEW.spend_authorization_id
          AND a.principal_kind=NEW.principal_kind AND a.principal_id=NEW.principal_id
          AND a.scope @> jsonb_build_array(jsonb_build_object('sourceId',NEW.source_id,'slug',NEW.slug))
          AND (NOT a.revoked OR (TG_OP='UPDATE' AND NEW.state IN ('cancelled','failed','committed')))) THEN
        RAISE EXCEPTION 'paid_import_budget: invalid authorization binding' USING ERRCODE='42501';
      END IF;
      IF NEW.state='running' AND COALESCE(current_setting('gbrain.paid_import_protocol',true),'')<>'1' THEN
        RAISE EXCEPTION 'paid_import_budget: upgraded owner required' USING ERRCODE='42501';
      END IF;
    ELSIF version<>1 THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: invalid page target' USING ERRCODE='42501';
    END IF;
    IF (version<>3 AND NEW.spend_authorization_id IS NOT NULL) OR (TG_OP='UPDATE' AND NEW.spend_authorization_id IS DISTINCT FROM OLD.spend_authorization_id) THEN
      RAISE EXCEPTION 'paid_import_budget: request budget binding is immutable' USING ERRCODE='42501';
    END IF;
    record:=NEW.recovery;
    IF record IS NOT NULL AND ((target='page' AND record->>'version' IS DISTINCT FROM '1')
      OR (target='skill_bundle' AND (record->>'version' IS DISTINCT FROM '2' OR record->>'target' IS DISTINCT FROM 'skill_bundle'
        OR jsonb_typeof(record->'files') IS DISTINCT FROM 'array'))) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: recovery target mismatch' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END $$;
DROP TRIGGER IF EXISTS gbrain_request_protocol ON persistence_requests;
CREATE TRIGGER gbrain_request_protocol BEFORE INSERT OR UPDATE OR DELETE ON persistence_requests
  FOR EACH ROW EXECUTE FUNCTION gbrain_guard_request_protocol();
  `;
export const IMAGE_SPEND_EXTENSION_SHA256 = createHash('sha256').update(IMAGE_SPEND_EXTENSION_SQL).digest('hex');
export const IMAGE_SPEND_GUARD_HASHES = ['gbrain_guard_request_protocol','gbrain_guard_spend_authorization'].map(name => {
  const start = IMAGE_SPEND_EXTENSION_SQL.indexOf(`FUNCTION ${name}()`);
  const bodyStart = IMAGE_SPEND_EXTENSION_SQL.indexOf('AS $$', start) + 5;
  const bodyEnd = IMAGE_SPEND_EXTENSION_SQL.indexOf('$$', bodyStart);
  if (start < 0 || bodyEnd < bodyStart) throw new Error(`Missing extension guard ${name}`);
  const sqlStart = IMAGE_SPEND_EXTENSION_SQL.lastIndexOf('CREATE OR REPLACE', start);
  return { name, sql: IMAGE_SPEND_EXTENSION_SQL.slice(sqlStart, bodyEnd + 3), md5: createHash('md5').update(IMAGE_SPEND_EXTENSION_SQL.slice(bodyStart, bodyEnd)).digest('hex') };
});
