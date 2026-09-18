# Texas Schedule directory connection

California Jamba uses the same directory-controlled display-name rule through a
separate fail-closed adapter. `mapping.california.json` pins the private copied
workbook, the six `Employee Names Master` name/ID column pairs, and 105 column-R
schedule cells. Sync writes only those master pairs and their validation rules;
it never writes selected names, times, formulas or formatting. Existing selected
inactive or renamed aliases remain available until removed from the schedule.

The manager interface is the **Texas Schedule** tab of the administrator-selected Texas target. The portal starts on the current private draft and exposes that same workbook as the pinned `Test Schedule — Current Directory Draft` option. The separate Directory Schedule experiment is deprecated and hidden. Never install the old `DirectoryAdapter.js` unchanged; its helper schema differs from the implemented connection.

`mapping.texas.json` is the reviewed mapping: 174 column-N name cells across eight stores, excluding six merged non-name rows. TX-162 rows 265-280 are all active schedule rows. Sunday starts/ends use P/Q, then U/V, Z/AA, AE/AF, AJ/AK, AO/AP and AT/AU. P1 supplies the Sunday date. The main sheet's 688-by-96 dimensions are checked before syncing/exporting; structural row changes require remapping.

## Target selection and production sync

Administrators select Texas and California independently. Each selector shows
the pinned test draft followed by the eight newest validated original schedules
from `ScheduleDB.google_sheets`, newest week first. Saving verifies Editor
capability and the reviewed base layout, records an audit event, and changes only
future sync routing. It performs no workbook write. Targets never auto-advance.

The first sync to an original Texas workbook idempotently creates and seeds the
hidden `Directory Roster` and `Directory Bindings` sheets when absent. The first
California sync idempotently seeds the reviewed `Employee Names Master` ranges.
Later syncs retain the same bounded write allowlists. Switching back to either
test draft leaves the prior original workbook at its last synced state.

The production portal at https://idad-employee-report-directory.vercel.app reads and writes its separate `employee_directory` database. Vercel runs `/api/cron/directory-sync` daily at `0 10 * * *` UTC (approximately 5 a.m. Central during daylight time, within Vercel's scheduling window). Administrators can use **Refresh roster** and each state’s **Sync now** control without waiting. Saving an employee or target alone does not immediately update dropdowns; use manual sync or wait for the daily cycle.

The old connected Preview deployment has been retired. Local automation and draft configuration are disabled, and future Preview deployments have no draft credential. Do not restart an independent test writer against this workbook. Two databases cannot coordinate a shared sync lease.

Only the two explicit selected targets are Google write destinations. The POS roster reader and ScheduleDB catalog principal are read-only. Database writes stay in the four production portal collections; DirectoryDB, unselected schedules, live reporting workflows and bound scripts remain unchanged.

`Directory Roster` A:F holds store, directory ID, POS ID/source, selection label and POS name. Historical labels are retained, including inactive selections. New labels cannot silently claim existing unbound text. Names are disambiguated by full/preferred names, never ID suffixes. Managers need to choose distinct preferred names if both names collide.

`Directory Bindings` D:E resolves selected exact labels against the hidden roster through row 5000. Lookup misses stay blank with a visible match-status instruction rather than a guessed identity. Hourly Calculations continues reading the existing names and times. Sync changes only helper values/formulas and N-cell validation; it never writes selected names, time cells, formats, or layouts.

## Export

In the portal, choose a store → **Schedule preview** → **Validate and export shifts**. Every populated mapped shift must have a resolved directory/POS identity and valid time pair. Unknown names, conflicts, incomplete times and ambiguous times remain exceptions. Overnight shifts require an explicit row/day annotation. Excluded rows require a reason and remain listed by date.

Ready full exports are stored by workbook/store/week in production sync state. Scoped tests use a separate key, so omissions cannot replace a complete store snapshot. Invalid attempts cannot replace either accepted snapshot. Stable shift IDs retain workbook/tab/row/slot/date provenance; edits replace revisions and deleted shifts disappear from the next complete snapshot.

Download JSON contains validated shifts from the configured schedule target. It does not update a legacy `Shift export` tab or a schedule database. The protected `POST /api/v1/reporting/draft-exports/validate` machine endpoint can revalidate complete, zero-exclusion store snapshots for the weekly Texas labor-report runner. It requires a dedicated report-only bearer token, blocks pending POS identities and issues, and returns the accepted JSON used by the report. PDF generation and verification remain downstream responsibilities.

## Recovery

Pause the scheduled job and remove the production draft connection settings in a reviewed deployment before restoring another writer. A deployment rollback alone does not reliably disable an already configured cron. Preserve both directory snapshots, the copied workbook and accepted exports. Never delete inactive employee identities or restore old helper formats over current manager edits. Use the shared Mongo sync leases; the old filesystem lock is obsolete.

## Implementation boundary

IDAD production has completed a reviewed handover to one hosted writer. Operational verification evidence remains owner-only and is intentionally excluded from Git. A separate implementation must repeat its own schedule mapping, authorization, read-back, unchanged-cell comparison, export reconciliation, and actual scheduler-delivery checks.
