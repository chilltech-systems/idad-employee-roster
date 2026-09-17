import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRepository } from "../src/lib/repository";
import { withSyncLease } from "../src/lib/sync-lease";
import { authorizeDailySync, runDailySync } from "../src/lib/daily-sync";
import { fetchRoster } from "../src/lib/roster-source";

test("shared lease rejects a competing worker and recovers after expiry without deleting its successor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "directory-lease-"));
  const repo = new FileRepository(join(dir, "state.json"));
  let time = 1000;
  try {
    await withSyncLease(
      "draft",
      async (held) => {
        await assert.rejects(
          withSyncLease(
            "draft",
            async () => {},
            repo,
            () => time,
          ),
          /already running/,
        );
        time += 600001;
        await assert.rejects(held(), /expired/);
        await repo.transact((s) => {
          s.sync.leases!.draft = {
            owner: "successor",
            expiresAt: time + 600000,
          };
        });
      },
      repo,
      () => time,
    );
    assert.equal(
      await repo.transact((s) => s.sync.leases?.draft?.owner),
      "successor",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("daily sync skips successful replay and retains accepted roster after later failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "directory-daily-"));
  const repo = new FileRepository(join(dir, "state.json"));
  const old = { ...process.env };
  process.env.PORTAL_MODE = "demo";
  delete process.env.VERCEL;
  let writes = 0;
  const date = () => new Date("2026-09-11T10:00:00Z");
  const write = async () => {
    writes++;
    return { ok: true, active: 1, aliases: 1, fingerprint: "fixture" };
  };
  try {
    assert.equal(
      (await runDailySync(repo, fetchRoster, write, date)).skipped,
      false,
    );
    assert.equal(
      (await runDailySync(repo, fetchRoster, write, date)).skipped,
      true,
    );
    assert.equal(writes, 1);
    const saved = await repo.transact((s) => s.sync.lastSuccess);
    await assert.rejects(
      runDailySync(
        repo,
        async () => {
          throw Error("private failure");
        },
        write,
        () => new Date("2026-09-12T10:00:00Z"),
      ),
      /last accepted data retained/,
    );
    const after = await repo.transact((s) => s.sync);
    assert.equal(after.lastSuccess, saved);
    assert.equal(after.automation?.lastDailyDate, "2026-09-11");
    assert.ok(!after.automation?.error?.includes("private failure"));
  } finally {
    process.env = old;
    await rm(dir, { recursive: true, force: true });
  }
});
test("cron requires its separate machine secret and explicit activation", () => {
  const old = { ...process.env };
  try {
    process.env.CRON_SECRET = "x".repeat(32);
    delete process.env.PORTAL_HOSTED_SYNC_ENABLED;
    assert.throws(() => authorizeDailySync(null), /Unauthorized/);
    assert.throws(() => authorizeDailySync("Bearer wrong"), /Unauthorized/);
    assert.throws(
      () => authorizeDailySync("Bearer " + "x".repeat(32)),
      /not enabled/,
    );
    process.env.PORTAL_HOSTED_SYNC_ENABLED = "yes";
    assert.doesNotThrow(() => authorizeDailySync("Bearer " + "x".repeat(32)));
  } finally {
    process.env = old;
  }
});
