/** Explicit installed-extension fixture for version-only advisor engine doubles. */
import { IMAGE_SPEND_EXTENSION_VERSION, IMAGE_SPEND_EXTENSION_SHA256, IMAGE_SPEND_GUARD_HASHES } from '../../src/core/fork-migrations/managed-image-spend.ts';
export function appliedForkExtensionRows(sql: string): unknown[] | undefined {
  if (sql.includes("to_regclass('gbrain_fork_migrations')")) return [{ ledger: true, storage: true, guard_count: IMAGE_SPEND_GUARD_HASHES.length }];
  if (sql.includes('SELECT version,ddl_sha256 FROM gbrain_fork_migrations')) return [{ version: IMAGE_SPEND_EXTENSION_VERSION, ddl_sha256: IMAGE_SPEND_EXTENSION_SHA256 }];
  return undefined;
}
