# A bounded managed-image rebuild

A finite foreground `embed --stale --images --max-usd N` cap now follows the request to its canonical owner. The owner reserves the full priced maximum of each actual provider attempt before sending it. An attempt whose maximum does not fit is refused, even when some money remains. Missing prices or input/output bounds refuse before transmission. Image publication does not enqueue a second text-embedding effect.

The command prints its authorization ID before admitting its first image, and reports the immutable cap, settled spend, and unresolved reservations without rounding the approval upward. `$0.025` remains exactly 2.5 cents. A response with unknown usage, or a process killed after reservation, keeps the full liability charged after its lease expires. Such an outcome is not evidence of zero cost.

A 30-second pending receipt stops the sweep. The accepted request may still complete in the owner; the remaining images are reported deferred, never unchanged or successful. Read the named request with `gbrain write-request -- <request-id>` before interpreting its result.

To continue within the **same** remaining approval:

```
gbrain embed --stale --images --source <source> --resume-spend <authorization-id> --json
```

Resume does not create a group, reset a limit, or suggest increasing it. It requires the original local CLI principal, the original selected source/slug scope, and the original provider/model IDs. Newly stale images outside that scope are excluded and counted; only the originally approved images still stale are processed. A zero-candidate resume still reports the original ledger. Changing the model configuration does not authorize a new destination. Pricing overrides are read for the current attempt, whose full maximum must still fit the original cap. Combining resume with a fresh `--yes`, `--max-usd`, or `--max-cost` approval is rejected. A separately approved fresh command creates a separate authorization; it is not an automatic retry of an old one.

The finite-cap path requires a declared, enforceable provider input bound. For Voyage on a host configured for bounded image preprocessing, the gateway's checked request-token maximum supplies that bound. Unsupported preprocessing, unpriced OCR, or an OCR call without a proven input/output ceiling refuses; the command does not silently fall back to an uncapped import. Original image files remain unchanged.

## Schema and compatibility

The independently named `frxiaobei/managed-image-spend` extension version 1 adds immutable `persistence_spend_authorizations`, the request authorization reference, and request attribution on spend reservations. Its version and DDL SHA256 live in `gbrain_fork_migrations`. It never allocates an upstream migration number or rewrites the official `config.version` (262 on this release's base). Official upstream migration 263 remains available.

Budgeted image imports use request protocol 3; page/skill base protocols remain 1/2. A separate transaction-local paid-import capability prevents an older owner from claiming these requests. Authority bindings, scope, and the live execution token are checked again before each reservation.

Use the staged new binary with `apply-migrations --list --json --require-db` or `apply-migrations --dry-run --json --require-db` for a read-only preview. Inspect `database.fork_extensions`; these commands do not apply the extension or finish unrelated host migrations. Preserve a verified database backup, old binary, and configuration before any ordinary new-binary connection command, because normal startup may initialize schema automatically.

In an idle window, verify there are no active jobs, pending writes or in-flight agent writes, atomically switch the binary, then run **`gbrain init --migrate-only --json`** using the existing host environment. This official path applies database schema and the fork extension without saving configuration, installing services, completing the unrelated 0.53 shared-skills host work, or unpausing autopilot. Gracefully replace the old HTTP/autopilot processes, preserve the pause marker, and verify the new extension state with the new binary before admitting a capped rebuild. Use the old binary only for no-database version/hash inspection after the switch.

There is no proposed global admission-disable command. `initSchema` owns the existing schema initialization lock, and the extension's DDL is one transaction with its own extension lock and bounded lock wait. First installation or missing storage/constraint/trigger repair needs request-table DDL. Subsequent initialization checks actual capabilities and replaces only drifted function bodies, without repeating request-table ALTERs. Initial installation DDL conflicts with in-flight writes; a lock timeout rolls back the extension and its ledger update. Inspect active work before retrying. Do not terminate another writer or remove accepted requests to bypass this.

Compatibility testing against archived 0.60.320.2 found that its `initSchema` and read-only `sources list --json` accept the database. However, old `initSchema` rewrites the request guard: the old owner then refuses protocol 3 as `unsupported_mutation_protocol` and leaves the request queued. The new read-only probe detects drift from the actual function bodies, even if the extension ledger still says version 1. Running new `init --migrate-only` restores the guards; the same original request and authorization can continue, with settled and unresolved spend unchanged. Keeping the old guard merely because the ledger version matches is explicitly forbidden.

A binary rollback therefore does not require restoring an old database dump by default, but the older owner cannot execute pending protocol-3 work. Keep that work and its ledger, or explicitly cancel it through the upgraded owner. Returning to the new release requires schema-only initialization and a guard-state check. A database restore is a separate recovery decision that must account for every write made since the backup; never drop the authorization or spend ledger to make a rollback appear clean.

Purge retains the immutable authorization and its settled/unresolved liabilities. Its source/slug scope contains locators, not image or page bodies; matching scope text is probed and disclosed as a residual in the purge receipt. A purge must not reset financial liability or claim that retained authorization metadata was erased.

These controls cannot reconstruct the cost of image requests admitted by an older release without durable authorization. Do not assign an old unknown charge to a new approval or claim that a prior combined cap was enforced retroactively.
