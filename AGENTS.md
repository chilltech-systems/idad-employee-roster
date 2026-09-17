<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Portal scope

This is a standalone service that can also be integrated behind a larger system. Read `docs/PRODUCTION-SNAPSHOT.md` and `docs/INTEGRATION-GUIDE.md` before changing runtime behavior. The owner-only local checkout may also contain `docs/IMPLEMENTATION-STATUS.md`; it is intentionally excluded from Git because it contains operational evidence.

Preserve the existing gateway, workflows, schedules and approved report calculations. Demo employees and demo codes are fictional and are not operational configuration. Production database mutation, publishing, deployment, activation and live-schedule replacement remain separate approval boundaries. Test-storage code deliberately refuses DirectoryDB.

Run `npm test`, `npm run typecheck`, `npm run build`, and the local API smoke check for service changes. Never mistake a passing local test for MongoDB, copied-workbook, browser, or production verification. Keep actual employee records and credentials out of Git. Repository publication and production deployment remain separate actions.
