# IDAD Employee Roster

IDAD Employee Roster is a production employee-directory service for maintaining stable employee identities across stores, POS systems, schedules, and reporting workflows. It combines a single-administrator web interface, a versioned HTTP API, MongoDB persistence, audited changes, Google roster ingestion, and guarded schedule-dropdown synchronization.

The application runs as a standalone Next.js service today, but its boundaries are intentionally documented so it can also sit behind a larger operations platform, be called through a backend-for-frontend, or supply identity-backed roster data to existing scheduling and reporting systems.

## What it provides

- One IDAD Admin Profile with access to every configured store; single-store login profiles are retired.
- Stable directory IDs separate from store-specific POS employee IDs.
- Multi-store profiles with retained inactive assignment history.
- Explicit identity review, audited archive/restore, and linking; names never trigger automatic merges.
- Optimistic revision checks and immutable audit history.
- Read-only mixed-POS roster discovery from completed weekly baselines plus a
  state-local daily labor gap and current-day sales/clock-ins.
- ID-backed schedule dropdowns and validated shift exports.
- Administrator-selected Texas and California schedule targets with pinned test drafts and explicit, audited changes.
- Report-only machine validation for complete weekly labor schedule exports.
- Daily or administrator-triggered synchronization with shared leases.
- OpenAPI 3.1 contract at [`docs/openapi.json`](docs/openapi.json).
- Fictional local demo data and a comprehensive automated test suite.

No credentials, employee records, database exports, or private schedule contents belong in this repository.

## Choose an integration pattern

| Pattern                  | Best use                                           | Boundary                                                                                                                    |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Standalone service       | Fastest deployment with the included UI            | Deploy the Next.js app and connect approved infrastructure through server-only environment variables.                       |
| Existing platform module | Add roster pages to a larger portal                | Keep this service behind the platform and proxy `/api/v1`; preserve its session, origin, authorization, and revision rules. |
| Backend integration      | Feed schedules, reporting, or identity workflows   | Use the OpenAPI contract and extended JSON roster responses with permanent IDs.                                             |
| Adapter replacement      | Connect another POS, database, or schedule product | Replace the source/draft adapters while retaining the domain model, authorization, audit, and validation layers.            |

Read the [integration guide](docs/INTEGRATION-GUIDE.md) before embedding the service. Configuration is documented in [configuration](docs/CONFIGURATION.md), security expectations in [security](SECURITY.md), and verification commands in [quality gates](docs/QUALITY-GATES.md).

## Local demo

Requires Node.js 22.13 or newer and npm.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3210`. The demo uses fictional stores and codes defined in the fixture source. It binds to loopback, rejects Vercel, makes no MongoDB or Google requests, and persists only to ignored `.data/demo.json`.

```sh
npm test
npm run typecheck
npm run build
npm run demo:flow
```

Run `npm run api:smoke` while the local server is running to verify authentication, store boundaries, origin protection, roster export, shift validation, and logout revocation.

## Repository map

- `src/app`: Next.js interface and API routes.
- `src/lib/model.ts`: domain schemas, permissions, and stable identity rules.
- `src/lib/service.ts`: authenticated employee, roster, refresh, and export operations.
- `src/lib/people.ts`: multi-store profile and explicit identity-linking operations.
- `src/lib/repository.ts`: local fixture storage and MongoDB transaction adapter.
- `src/lib/roster-source.ts`: replaceable read-only roster-source boundary.
- `src/lib/google-draft.ts`: bounded schedule-workbook adapter.
- `src/lib/shifts.ts`: shift validation and identity-backed labor diagnostics.
- `schedule/`: schedule mapping contract and Apps Script reference adapter.
- `scripts/`: local verification, provisioning-plan, contract-generation, and sync tools.
- `tests/`: domain, authorization, adapter, storage, and integration tests.

## Production snapshot

This repository starts from the source serving the existing IDAD production application as of September 17, 2026. Publishing the repository does not connect GitHub to Vercel, change Production, run a migration, activate a workflow, or copy runtime data. Those remain separate reviewed operations.

The production-specific database name, runtime principal guard, Google workbook mapping, and store configuration are deliberate safety controls. A separate implementation must supply its own infrastructure and either preserve or deliberately adapt those guards. See [production snapshot](docs/PRODUCTION-SNAPSHOT.md).

## Non-negotiable data rules

- Never merge employees by name alone.
- Keep store, source, POS, directory, and shared-person identifiers distinct.
- Retain inactive assignments and audit history.
- Keep all secrets server-side and outside Git.
- Do not treat a schedule sync, roster refresh, or API success as proof of downstream report delivery.
- Store only the report token hash in the portal environment; keep the raw report token in the owner-only Data Gateway environment.
- Validate a complete source-to-destination flow before connecting a production schedule or reporting pipeline.

## License and access

This is a private CHILL TECH/IDAD operational repository. Access to the repository does not grant access to IDAD production data, credentials, MongoDB, Google workbooks, Vercel, or downstream reporting systems.
