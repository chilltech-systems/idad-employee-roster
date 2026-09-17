import { createHash, timingSafeEqual } from "node:crypto";
import { repository, type Repository } from "./repository";
import { fetchRoster } from "./roster-source";
import { refresh } from "./service";
import { syncDraftNow } from "./draft-operations";
import { withSyncLease } from "./sync-lease";
import { Problem } from "./model";

export function authorizeDailySync(header: string | null) {
  const secret = process.env.CRON_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    !header ||
    !timingSafeEqual(
      createHash("sha256").update(header).digest(),
      createHash("sha256").update(`Bearer ${secret}`).digest(),
    )
  )
    throw new Problem(401, "Unauthorized.");
  if (process.env.PORTAL_HOSTED_SYNC_ENABLED !== "yes")
    throw new Problem(503, "Hosted sync is not enabled.");
}

export async function runDailySync(
  repo: Repository = repository(),
  readRoster = fetchRoster,
  writeDraft = syncDraftNow,
  now = () => new Date(),
) {
  return withSyncLease(
    "daily",
    async (assertHeld) => {
      const day = now().toISOString().slice(0, 10);
      if (await repo.transact((s) => s.sync.automation?.lastDailyDate === day))
        return { ok: true, skipped: true };
      try {
        const snapshot = await readRoster();
        await assertHeld();
        const result = await repo.transact((s) =>
          refresh(s, { id: "hosted-daily-sync", role: "admin" }, snapshot),
        );
        if (result.error) throw new Error("Roster validation failed.");
        await repo.transact((s) => {
          s.sync.automation = {
            ...s.sync.automation,
            lastRoster: now().toISOString(),
          };
        });
        await assertHeld();
        await writeDraft();
        await repo.transact((s) => {
          s.sync.automation = {
            ...s.sync.automation,
            heartbeat: now().toISOString(),
            cadence: "daily",
            lastDailyDate: day,
            error: undefined,
          };
        });
        return { ok: true, skipped: false };
      } catch {
        await repo.transact((s) => {
          s.sync.automation = {
            ...s.sync.automation,
            cadence: "daily",
            error:
              "Daily sync failed; review connections and retry. Last accepted data retained.",
          };
        });
        throw new Problem(
          502,
          "Daily sync failed; last accepted data retained.",
        );
      }
    },
    repo,
  );
}
