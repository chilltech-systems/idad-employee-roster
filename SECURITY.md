# Security policy

Report suspected vulnerabilities privately to the repository owner. Do not open a public issue containing employee data, credentials, connection strings, workbook identifiers, session material, or production screenshots.

## Required controls

- Use dedicated least-privilege database and Google service identities.
- Keep all secrets in server-side environment storage.
- Preserve exact-origin checks, secure HTTP-only cookies, store authorization, administrator authorization, revision checks, and audit immutability.
- Never auto-link employee identities from names.
- Never use demo codes or fixture data in an operational deployment.
- Keep production provisioning, migration, deployment, and scheduler activation behind separate reviewed approvals.

If a credential is exposed, revoke or rotate it first, then assess logs and affected data. Removing it from a later commit does not remove it from Git history.
