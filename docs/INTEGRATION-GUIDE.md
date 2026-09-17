# Integration guide

IDAD Employee Roster is easiest to integrate as an identity service with a web interface, not as a shared in-process package. The HTTP boundary keeps employee authorization, auditing, revisions, and data-source credentials in one place.

## Recommended topology

```text
Existing operations platform
  -> backend-for-frontend or reverse proxy
    -> IDAD Employee Roster /api/v1
      -> scoped MongoDB collections
      -> read-only roster source adapter
      -> optional guarded schedule adapter
```

Browser clients should talk to the existing platform origin. That platform can proxy roster routes to this service or present the roster UI at a same-origin path. Do not weaken the service's origin checks or expose MongoDB/Google credentials to the browser to make cross-origin embedding easier.

## Stable boundaries

The primary integration contract is `docs/openapi.json`. The most important boundaries are:

- Session authentication and logout through the API.
- Store-scoped employee and roster operations.
- Administrator-only shared profiles and explicit linking.
- Revision tokens on mutations to prevent stale writes.
- Extended JSON roster exports carrying stable directory IDs.
- Compatibility CSV for legacy consumers that cannot yet accept extended JSON.
- A protected cron endpoint for the daily refresh/schedule cycle.

Treat the compatibility CSV as a transition format. New integrations should use JSON and retain the directory ID, store ID, POS source, POS employee ID, shared person ID, assignment status, and pending-POS flag as separate fields.

## Integration paths

### 1. Reverse proxy into an existing portal

Mount the application behind the larger system and forward cookies, method, body, and origin consistently. Keep `/api/v1` and `/api/cron/directory-sync` server-side. Verify login, authorization, stale revisions, logout revocation, and foreign-origin denial through the proxy before rollout.

### 2. Backend-to-backend roster consumer

Use a dedicated authenticated workflow that requests the JSON roster for one store at a time. Store permanent IDs as strings. Downstream systems must not recreate identity from display names. A successful API response proves only that the roster was returned; verify the downstream write or report independently.

### 3. Replace the roster source

Implement the contract used by `src/lib/roster-source.ts`. The adapter must return a complete, bounded snapshot, reject malformed or duplicate store/source/POS identities, and remain read-only. The refresh service will update verification and queue unknown identities for review; it must not infer links from names.

### 4. Replace the schedule adapter

Preserve the logic in `src/lib/draft-schedule.ts`: stable hidden IDs, historical aliases, collision handling, explicit exclusions, complete-snapshot validation, and separation of ready full exports from scoped tests. A new adapter may target another spreadsheet or scheduling product, but it must not overwrite manager-entered names/times without an explicit reviewed contract.

### 5. Extract domain logic into a larger codebase

If the larger system must own the UI and runtime, move these layers together:

- `model.ts`, `people.ts`, `people-list.ts`, `service.ts`, and `storage-scope.ts` for identity and authorization behavior.
- `repository.ts` behind a replacement repository interface.
- `shifts.ts` and `draft-schedule.ts` when schedule/labor features are required.

Do not copy only the UI components; the server-side permission, revision, transaction, and audit rules are the safety boundary.

## Data mapping checklist

Before implementation, map every external field to one of these concepts:

| Concept | Meaning |
| --- | --- |
| `id` / directory ID | Permanent assignment identity owned by this service. |
| `personId` | Shared person identity used for explicitly linked multi-store assignments. |
| `storeId` | Destination store assignment; never inferred from a name. |
| `posSource` | Namespace of the upstream POS identity. |
| `posEmployeeId` | Store/source-specific external ID; it may be pending. |
| `revision` | Concurrency token required for reviewed mutations. |
| `status` | Active/inactive assignment state retained historically. |

## Acceptance gates

An integration is not complete until it verifies:

1. Clean installation and all repository quality gates.
2. Authentication, store scope, administrator scope, origin denial, and logout revocation.
3. Database validators, transactions, least-privilege access, and backup/restore.
4. A source snapshot with duplicate/malformed/truncation failures.
5. One explicit new-identity review without name-based auto-linking.
6. One multi-store assignment through save and read-back.
7. If schedules are connected, one end-to-end ID-backed selection and export while manager-entered cells remain unchanged.
8. If reports consume exports, independent source-to-report reconciliation.
9. Scheduler evidence from an actual scheduled run, not only a manual invocation.

## IDAD-specific guards

The checked-in production runtime deliberately restricts its production database name and MongoDB principal. Google source/draft adapters also contain IDAD-specific workbook defaults and mapping assumptions. These are safety controls, not general defaults. A separate implementation should introduce its own reviewed configuration instead of weakening or bypassing the existing guards.
