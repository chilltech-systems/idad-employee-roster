# Configuration

All non-demo configuration is server-only. Do not create `NEXT_PUBLIC_*` versions of credentials, connection strings, tokens, store lists, or account codes.

## Core runtime

| Variable                          | Purpose                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `PORTAL_MODE`                     | `demo`, `mongo-test`, or the guarded IDAD `mongo-production` mode.  |
| `PORTAL_ORIGIN`                   | Exact allowed application origin, without a trailing slash.         |
| `PORTAL_STORES_JSON`              | Validated array of configured stores for Mongo-backed modes.        |
| `PORTAL_MONGODB_URI`              | Dedicated least-privilege MongoDB connection string.                |
| `PORTAL_MONGODB_DATABASE`         | Database selected by the guarded runtime.                           |
| `PORTAL_ENABLE_TEST_WRITES`       | Explicit `yes` gate for isolated test storage.                      |
| `PORTAL_ENABLE_PRODUCTION_WRITES` | Explicit `yes` gate used only by the reviewed IDAD production mode. |

## Roster source

| Variable                             | Purpose                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `PORTAL_ROSTER_SOURCE`               | Selects the configured roster adapter.                   |
| `PORTAL_ROSTER_URL`                  | Optional HTTPS source for a token-authenticated adapter. |
| `PORTAL_ROSTER_TOKEN`                | Server-only bearer token for that source.                |
| `PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE` | Local-only path to a roster-reader credential.           |
| `PORTAL_GOOGLE_SERVICE_ACCOUNT_JSON` | Hosted server-only roster-reader credential JSON.        |

The Google adapter supplies the four most recently completed Monday-Sunday
weeks. Each refresh then fills the following Monday through each configured
store's local current date: completed dates come from normalized daily labor,
and the current date comes from the configured QU or Toast employee-sales and
clocked-in sources. Store codes are matched canonically, so forms such as
`JJ-025`, `jj-25`, and `jj25` resolve to the same configured store while POS
identity remains exact by store, source, and employee ID. Every expected source
and completed date must succeed before a snapshot is accepted. Previously
observed identities are retained when the rolling window advances.

## Schedule synchronization

| Variable                                   | Purpose                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `PORTAL_DRAFT_ID`                          | Approved schedule/draft target identifier.                                                                                  |
| `PORTAL_CALIFORNIA_DRAFT_ID`               | Approved California Jamba schedule draft identifier.                                                                        |
| `PORTAL_SCHEDULE_CATALOG_MONGODB_URI`      | Dedicated read-only ScheduleDB connection used only to list the newest original Texas and California schedules.             |
| `PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE` | Local-only draft-writer credential path.                                                                                    |
| `PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON` | Hosted server-only draft-writer credential JSON.                                                                            |
| `PORTAL_AUTOMATION_ENABLED`                | Local worker gate. Do not run it against the same target as hosted sync.                                                    |
| `PORTAL_HOSTED_SYNC_ENABLED`               | Hosted daily endpoint gate.                                                                                                 |
| `CRON_SECRET`                              | Random machine credential for the protected daily endpoint.                                                                 |
| `PORTAL_REPORT_EXPORT_TOKEN_SHA256`        | SHA-256 hex digest of the dedicated bearer token allowed only to validate and retrieve complete labor-report shift exports. |

The two fixed draft IDs are the server-owned `Test Schedule — Current Directory
Draft` targets and remain the initial active targets. The administrator can save
an independent Texas or California target from the eight newest validated
`ScheduleDB.google_sheets` records. Saving performs catalog, permission, and
layout reads plus portal-state persistence only; it does not write the selected
workbook. New ScheduleDB records never advance an active target automatically.

Manual and hosted schedule synchronization update the independently selected workbooks.
Texas retains its hidden identity roster, column-N dropdowns and validated shift
exports. California refreshes the six reviewed store lists in `Employee Names
Master` and the 105 strict column-R dropdown cells. Neither sync writes a
manager-selected schedule name, shift time, format or formula.

## Operator-only setup variables

The test provisioner and account setup scripts use additional confirmation and account variables. Supply them through an owner-only environment file or secret manager, never command arguments, Git, logs, screenshots, or generated documentation.

Start from `.env.example`. Production values are intentionally absent from this repository.
