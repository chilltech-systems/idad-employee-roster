# Configuration

All non-demo configuration is server-only. Do not create `NEXT_PUBLIC_*` versions of credentials, connection strings, tokens, store lists, or account codes.

## Core runtime

| Variable | Purpose |
| --- | --- |
| `PORTAL_MODE` | `demo`, `mongo-test`, or the guarded IDAD `mongo-production` mode. |
| `PORTAL_ORIGIN` | Exact allowed application origin, without a trailing slash. |
| `PORTAL_STORES_JSON` | Validated array of configured stores for Mongo-backed modes. |
| `PORTAL_MONGODB_URI` | Dedicated least-privilege MongoDB connection string. |
| `PORTAL_MONGODB_DATABASE` | Database selected by the guarded runtime. |
| `PORTAL_ENABLE_TEST_WRITES` | Explicit `yes` gate for isolated test storage. |
| `PORTAL_ENABLE_PRODUCTION_WRITES` | Explicit `yes` gate used only by the reviewed IDAD production mode. |

## Roster source

| Variable | Purpose |
| --- | --- |
| `PORTAL_ROSTER_SOURCE` | Selects the configured roster adapter. |
| `PORTAL_ROSTER_URL` | Optional HTTPS source for a token-authenticated adapter. |
| `PORTAL_ROSTER_TOKEN` | Server-only bearer token for that source. |
| `PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE` | Local-only path to a roster-reader credential. |
| `PORTAL_GOOGLE_SERVICE_ACCOUNT_JSON` | Hosted server-only roster-reader credential JSON. |

## Schedule synchronization

| Variable | Purpose |
| --- | --- |
| `PORTAL_DRAFT_ID` | Approved schedule/draft target identifier. |
| `PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE` | Local-only draft-writer credential path. |
| `PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON` | Hosted server-only draft-writer credential JSON. |
| `PORTAL_AUTOMATION_ENABLED` | Local worker gate. Do not run it against the same target as hosted sync. |
| `PORTAL_HOSTED_SYNC_ENABLED` | Hosted daily endpoint gate. |
| `CRON_SECRET` | Random machine credential for the protected daily endpoint. |

## Operator-only setup variables

The test provisioner and account setup scripts use additional confirmation and account variables. Supply them through an owner-only environment file or secret manager, never command arguments, Git, logs, screenshots, or generated documentation.

Start from `.env.example`. Production values are intentionally absent from this repository.
