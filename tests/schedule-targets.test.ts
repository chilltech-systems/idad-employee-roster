import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import { DRAFT_ID } from "../src/lib/google-draft";
import { CALIFORNIA_DRAFT_ID } from "../src/lib/google-california-draft";
import {
  parseScheduleCatalogDocument,
  type ScheduleCatalogEntry,
} from "../src/lib/schedule-catalog";
import {
  activeScheduleTarget,
  resolveScheduleTarget,
  saveScheduleTarget,
  scheduleTargetOptions,
  targetOverview,
  TEST_TARGET_KEY,
} from "../src/lib/schedule-targets";

const admin = { id: "IDADadmin", role: "admin" as const };

function schedule(index: number, state = "texas") {
  const sheetId = `sheet_${state}_${String(index).padStart(20, "0")}`;
  return {
    scheduleId: `${state}-${index}`,
    sheetId,
    sheetName: `${state} week ${index}`,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    weekStart: `2026-${String(index).padStart(2, "0")}-01`,
    weekEnd: `2026-${String(index).padStart(2, "0")}-07`,
  };
}

test("catalog returns exactly the eight newest valid schedules", () => {
  const entries = parseScheduleCatalogDocument(
    {
      state: "texas",
      schedules: Array.from({ length: 10 }, (_, i) => schedule(i + 1)),
    },
    "texas",
  );
  assert.equal(entries.length, 8);
  assert.deepEqual(
    entries.map((entry) => entry.scheduleId),
    [10, 9, 8, 7, 6, 5, 4, 3].map((index) => `texas-${index}`),
  );
  assert.ok(entries.every((entry) => entry.targetKey.startsWith("schedule:")));
});

test("catalog skips stale identity mismatches and rejects duplicate workbook records", () => {
  const mismatched = schedule(1);
  mismatched.sheetUrl =
    "https://docs.google.com/spreadsheets/d/a_different_workbook_12345/edit";
  const entries = parseScheduleCatalogDocument(
    {
      state: "texas",
      schedules: [
        mismatched,
        ...Array.from({ length: 10 }, (_, i) => schedule(i + 2)),
      ],
    },
    "texas",
  );
  assert.equal(entries.length, 8);
  assert.ok(entries.every((entry) => entry.scheduleId !== mismatched.scheduleId));
  assert.throws(
    () =>
      parseScheduleCatalogDocument(
        { state: "texas", schedules: [mismatched] },
        "texas",
      ),
    /no valid schedules/,
  );
  assert.throws(
    () =>
      parseScheduleCatalogDocument(
        { state: "texas", schedules: [schedule(1), schedule(1)] },
        "texas",
      ),
    /duplicates/,
  );
});

test("the server-owned test draft is pinned before eight catalog choices", async () => {
  const previous = process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI;
  process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI = "mongodb://fixture.invalid";
  try {
    const catalog = Array.from({ length: 8 }, (_, index) => ({
      ...schedule(index + 1),
      state: "texas" as const,
      targetKey: `schedule:texas-${index + 1}`,
    }));
    const options = await scheduleTargetOptions(
      "texas",
      async () => catalog as ScheduleCatalogEntry[],
    );
    assert.equal(options.length, 9);
    assert.equal(options[0].targetKey, TEST_TARGET_KEY);
    assert.equal(options[0].spreadsheetId, DRAFT_ID);
    assert.equal(
      options[0].sheetName,
      "Test Schedule — Current Directory Draft",
    );
  } finally {
    if (previous === undefined)
      delete process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI;
    else process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI = previous;
  }
});

test("test selections cannot override their server-owned workbook identities", async () => {
  const inspected: string[] = [];
  const resolved = await resolveScheduleTarget(
    { state: "california", targetKey: TEST_TARGET_KEY },
    async () => [],
    async (_state, spreadsheetId) => {
      inspected.push(spreadsheetId);
      return { title: "fixture", readiness: "test-draft" as const };
    },
  );
  assert.deepEqual(inspected, [CALIFORNIA_DRAFT_ID]);
  assert.equal(resolved.option.spreadsheetId, CALIFORNIA_DRAFT_ID);
  await assert.rejects(
    () =>
      resolveScheduleTarget(
        {
          state: "california",
          targetKey: TEST_TARGET_KEY,
          spreadsheetId: "attacker-controlled-workbook",
        },
        async () => [],
        async () => ({ title: "fixture", readiness: "test-draft" as const }),
      ),
    /unrecognized key/i,
  );
});

test("cross-state, forged, and disappeared schedule keys are rejected", async () => {
  const texas = {
    ...schedule(1),
    state: "texas" as const,
    targetKey: "schedule:texas-1",
  } as ScheduleCatalogEntry;
  const inspect = async () => ({
    title: "fixture",
    readiness: "needs-preparation" as const,
  });
  await assert.rejects(
    () =>
      resolveScheduleTarget(
        { state: "california", targetKey: texas.targetKey },
        async () => [],
        inspect,
      ),
    /no longer available/,
  );
  await assert.rejects(
    () =>
      resolveScheduleTarget(
        { state: "texas", targetKey: "https://example.invalid/workbook" },
        async () => [texas],
        inspect,
      ),
    /Unknown schedule target/,
  );
});

test("saving changes only portal state and records an immutable audit event", async () => {
  const state = seed(),
    catalog = {
      ...schedule(1),
      state: "texas" as const,
      targetKey: "schedule:texas-1",
    } as ScheduleCatalogEntry;
  let metadataReads = 0;
  const resolved = await resolveScheduleTarget(
    { state: "texas", targetKey: catalog.targetKey },
    async () => [catalog],
    async () => {
      metadataReads++;
      return { title: "fixture", readiness: "needs-preparation" as const };
    },
  );
  const target = saveScheduleTarget(
    state,
    admin,
    resolved,
    () => "2026-09-18T12:00:00.000Z",
  );
  assert.equal(metadataReads, 1);
  assert.equal(target.readiness, "needs-preparation");
  assert.equal(
    activeScheduleTarget(state, "texas").spreadsheetId,
    catalog.sheetId,
  );
  assert.deepEqual(state.audit.at(-1), {
    id: state.audit.at(-1)!.id,
    at: "2026-09-18T12:00:00.000Z",
    actor: "IDADadmin",
    action: "schedule.target-selected",
    reason: "texas: Test Schedule — Current Directory Draft -> texas week 1",
  });
});

test("a target change cannot race an active state sync", async () => {
  const state = seed();
  state.sync.leases = {
    "draft:texas": { owner: "fixture", expiresAt: Date.now() + 60_000 },
  };
  assert.throws(
    () =>
      saveScheduleTarget(state, admin, {
        option: {
          state: "texas",
          targetKey: TEST_TARGET_KEY,
          kind: "test",
          scheduleId: TEST_TARGET_KEY,
          spreadsheetId: DRAFT_ID,
          sheetName: "Test Schedule — Current Directory Draft",
          sheetUrl: `https://docs.google.com/spreadsheets/d/${DRAFT_ID}/edit`,
        },
        readiness: "test-draft",
      }),
    /sync is running/,
  );
});

test("non-administrators cannot list or change schedule targets", async () => {
  const state = seed(),
    storeAccount = {
      id: "store-user",
      role: "store" as const,
      storeId: "TX-162",
    };
  await assert.rejects(
    () => targetOverview(state, storeAccount, async () => []),
    /Administrator access required/,
  );
  assert.throws(
    () =>
      saveScheduleTarget(state, storeAccount, {
        option: {
          state: "texas",
          targetKey: TEST_TARGET_KEY,
          kind: "test",
          scheduleId: TEST_TARGET_KEY,
          spreadsheetId: DRAFT_ID,
          sheetName: "Test Schedule — Current Directory Draft",
          sheetUrl: `https://docs.google.com/spreadsheets/d/${DRAFT_ID}/edit`,
        },
        readiness: "test-draft",
      }),
    /Administrator access required/,
  );
});
