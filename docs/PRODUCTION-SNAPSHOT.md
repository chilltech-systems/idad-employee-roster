# Production snapshot

The initial GitHub version represents the application source serving IDAD production on September 17, 2026.

## Included behavior

- One IDAD Admin Profile with secure, revocable sessions; existing single-store credentials and sessions are rejected by the application.
- Administrator-controlled employee management and roster exports for every configured store.
- Administrator All Employees views for active/inactive, store, multi-store, state, and search filters.
- Retained inactive assignments and audited activation/deactivation.
- Explicit shared-person linking and multi-store assignment management.
- Read-only roster discovery and reviewed candidate handling.
- MongoDB transaction/revision controls across four scoped collections.
- Guarded schedule dropdown synchronization and identity-backed shift exports.
- Dedicated report-only validation/export contract for complete weekly labor schedule snapshots.
- Protected daily sync endpoint plus administrator manual operations.

## Deliberately not in Git

- Runtime secrets and local environment files.
- Employee records, database exports, schedule contents, and generated shift snapshots.
- Owner-only migration payloads, credential rotation tooling, and operational approval records.
- Production verification evidence containing internal record or deployment details.

## Publication boundary

The GitHub repository is a source snapshot and collaboration surface. It is not automatically connected to the existing Vercel project. A push does not deploy, migrate data, change the scheduler, sync a workbook, or alter an employee record.

The reporting endpoint also remains inactive until its reviewed code is deployed and `PORTAL_REPORT_EXPORT_TOKEN_SHA256` is configured in the intended production environment. Never commit or log the raw token.
