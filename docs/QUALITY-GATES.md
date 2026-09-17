# Quality gates

Run these checks for every change:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

For API or service changes, start the local fictional demo and run:

```sh
npm run api:smoke
```

For OpenAPI changes, regenerate `docs/openapi.json` with `npm run api:contract`, then review the diff.

## What these checks establish

- Domain, identity, authorization, transaction, adapter, schedule, and export behavior covered by tests.
- TypeScript compatibility.
- A complete optimized Next.js build.
- Local API authentication and boundary behavior when the smoke check is included.

## What they do not establish

- Connectivity or least-privilege scope for a real database.
- Correctness of an external roster feed.
- Safety of a live schedule write.
- Delivery of a scheduled invocation.
- Downstream report generation or delivery.
- Production readiness of a new deployment environment.

Those require separate environment-specific acceptance and read-back evidence.
