import { randomUUID } from "node:crypto";
import { Problem } from "./model";
import { repository, type Repository } from "./repository";

export async function withSyncLease<T>(
  name: "draft" | "daily",
  work: (assertHeld: () => Promise<void>) => Promise<T>,
  repo: Repository = repository(),
  now: () => number = Date.now,
) {
  const owner = randomUUID();
  await repo.transact((s) => {
    if ((s.sync.leases?.[name]?.expiresAt ?? 0) > now())
      throw new Problem(409, "Sync is already running. Retry shortly.");
    s.sync.leases ??= {};
    // Longer than the hosted function's five-minute maximum execution.
    s.sync.leases[name] = { owner, expiresAt: now() + 10 * 60_000 };
  });
  const assertHeld = async () => {
    await repo.transact((s) => {
      const lease = s.sync.leases?.[name];
      // Leave more time than the bounded Google write request before expiry.
      if (lease?.owner !== owner || lease.expiresAt - now() < 60_000)
        throw new Problem(409, "Sync lease expired; retry with fresh data.");
    });
  };
  try {
    return await work(assertHeld);
  } finally {
    await repo.transact((s) => {
      if (s.sync.leases?.[name]?.owner === owner) delete s.sync.leases[name];
    });
  }
}
