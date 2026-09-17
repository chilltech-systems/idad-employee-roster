import test from "node:test";
import assert from "node:assert/strict";
import {
  planDraftSync,
  extractDraft,
  validateDraftExport,
  recordDraftExport,
  type DraftGrid,
} from "../src/lib/draft-schedule";
import {
  DRAFT_ID,
  MAIN_ID,
  ROSTER_ID,
  BINDINGS_ID,
  draftClient,
} from "../src/lib/google-draft";
import { seed } from "../src/lib/seed";
import type { Employee } from "../src/lib/model";
function employee(id = "one"): Employee {
  return {
    ...seed().employees[0],
    id,
    storeId: "TX-149",
    posEmployeeId: id === "one" ? "001" : "002",
    firstName: "Jamie",
    lastName: id === "one" ? "Cooper" : "Carson",
    preferredName: "",
    posName: "Jamie Cooper",
    status: "active",
    verification: "confirmed",
  };
}
function grid() {
  const g: DraftGrid = {
    spreadsheetId: DRAFT_ID,
    sheets: [
      {
        properties: {
          sheetId: MAIN_ID,
          title: "Texas Schedule",
          gridProperties: { rowCount: 688, columnCount: 96 },
        },
        data: [
          { rowData: Array.from({ length: 525 }, () => ({ values: [] })) },
        ],
      },
      {
        properties: {
          sheetId: ROSTER_ID,
          title: "Directory Roster",
          gridProperties: { rowCount: 100, columnCount: 6 },
        },
        data: [{ rowData: [] }],
      },
      {
        properties: {
          sheetId: BINDINGS_ID,
          title: "Directory Bindings",
          gridProperties: { rowCount: 181, columnCount: 6 },
        },
        data: [
          { rowData: Array.from({ length: 181 }, () => ({ values: [] })) },
        ],
      },
    ],
  };
  set(g, MAIN_ID, 1, 16, 46271); // 2026-09-06
  const roster = [
    [
      "Store ID",
      "Directory ID",
      "POS ID",
      "POS source",
      "Selection label",
      "POS name",
    ],
    ["TX-149", "one", "001", "Qu", "Jamie C.", "Jamie Cooper"],
  ];
  roster.forEach((r, i) =>
    r.forEach((v, j) => set(g, ROSTER_ID, i + 1, j + 1, v)),
  );
  for (let r = 2; r <= 181; r++)
    for (const c of [4, 5]) {
      set(g, BINDINGS_ID, r, c, "");
      g.sheets[2].data![0].rowData![r - 1].values![c - 1] = {
        userEnteredValue: {
          formulaValue: "=INDEX('Directory Roster'!$B$2:$B$91,1)",
        },
      };
    }
  set(g, MAIN_ID, 22, 14, "Jamie C.");
  set(g, MAIN_ID, 22, 16, 9 / 24);
  set(g, MAIN_ID, 22, 17, 17 / 24);
  return g;
}
function set(
  g: DraftGrid,
  id: number,
  r: number,
  c: number,
  value: string | number,
) {
  const s = g.sheets.find((s) => s.properties.sheetId === id)!;
  const rows = s.data![0].rowData!;
  rows[r - 1] ??= { values: [] };
  rows[r - 1].values![c - 1] = {
    userEnteredValue:
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value },
    effectiveValue:
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value },
  };
}
test("refresh retains selected inactive/renamed identity and never writes manager cells", () => {
  const g = grid(),
    e = employee();
  e.preferredName = "Jay";
  const p = planDraftSync(g, [e]);
  assert.equal(p.roster.length, 2);
  assert.equal(p.roster[0][4], "Jamie C.");
  assert.equal(p.roster[1][4], "Jay");
  assert.ok(
    p.requests.every(
      (r: any) => !r.updateCells || r.updateCells.range.sheetId !== MAIN_ID,
    ),
  );
  const formula = (
    p.requests.find(
      (r: any) => r.updateCells?.range.sheetId === BINDINGS_ID,
    ) as any
  ).updateCells.rows[0].values[0].userEnteredValue.formulaValue;
  assert.match(formula, /\$B\$5000/);
  e.status = "inactive";
  const inactive = planDraftSync(g, [e]);
  assert.equal(inactive.roster[0][1], "one");
  assert.equal(inactive.active, 0);
});
test("name collisions disambiguate with full names, never numbers; unbound names cannot be claimed", () => {
  const g = grid(),
    a = employee(),
    b = employee("two");
  const p = planDraftSync(g, [a, b]);
  assert.equal(p.roster[1][4], "Jamie Carson");
  b.firstName = "New";
  b.lastName = "Person";
  set(g, MAIN_ID, 23, 14, "New P.");
  assert.throws(() => planDraftSync(g, [a, b]), /unbound/);
});
test("draft exports preserve dates, identities, explicit omissions, and stable replacement/removal", () => {
  const g = grid(),
    e = employee();
  const first = validateDraftExport(g, [e], "TX-149", undefined);
  assert.equal(first.snapshot.weekStart, "2026-09-06");
  assert.equal(first.snapshot.valid, 1);
  assert.equal(first.snapshot.shifts[0].minutes, 480);
  const repeat = validateDraftExport(g, [e], "TX-149", first);
  assert.deepEqual(repeat, first);
  set(g, MAIN_ID, 22, 16, "");
  set(g, MAIN_ID, 22, 17, "");
  const removed = validateDraftExport(g, [e], "TX-149", first);
  assert.equal(removed.snapshot.valid, 0);
  assert.equal(removed.snapshot.revision, 2);
  set(g, MAIN_ID, 23, 16, 9 / 24);
  set(g, MAIN_ID, 23, 17, 17 / 24);
  const invalid = validateDraftExport(g, [e], "TX-149", first);
  assert.equal(invalid.snapshot.exceptionCount, 1);
  const state = seed();
  recordDraftExport(state, first);
  recordDraftExport(state, invalid);
  assert.equal(Object.values(state.sync.draftExports!)[0].snapshot.valid, 1);
  const excluded = validateDraftExport(g, [e], "TX-149", undefined, [
    { row: 23, reason: "New hire pending" },
  ]);
  assert.equal(excluded.omitted.length, 1);
  assert.equal(excluded.snapshot.ready, true);
});
test("overnight requires explicit annotation and non-draft/unknown-store inputs fail closed", () => {
  const g = grid();
  set(g, MAIN_ID, 22, 16, 22 / 24);
  set(g, MAIN_ID, 22, 17, 6 / 24);
  assert.equal(
    validateDraftExport(g, [employee()], "TX-149", undefined).snapshot.ready,
    false,
  );
  assert.equal(
    validateDraftExport(
      g,
      [employee()],
      "TX-149",
      undefined,
      [],
      [{ row: 22, day: 0 }],
    ).snapshot.shifts[0].minutes,
    480,
  );
  assert.throws(() => extractDraft(g, "OTHER", 1), /mapped/);
  g.spreadsheetId = "production";
  assert.throws(() => planDraftSync(g, [employee()]), /draft/);
});
test("unconfigured draft client never requests a token", async () => {
  const old = process.env.PORTAL_DRAFT_ID;
  delete process.env.PORTAL_DRAFT_ID;
  await assert.rejects(
    () =>
      draftClient(async () => {
        throw Error("must not call");
      }),
    /not enabled/,
  );
  if (old) process.env.PORTAL_DRAFT_ID = old;
});

test("scoped exclusions cannot replace a full store snapshot and layout drift is rejected", () => {
  const g = grid(),
    e = employee(),
    s = seed();
  const full = validateDraftExport(g, [e], "TX-149", undefined);
  recordDraftExport(s, full);
  const partial = validateDraftExport(g, [e], "TX-149", undefined, [
    { row: 22, reason: "Explicit scoped test" },
  ]);
  recordDraftExport(s, partial);
  assert.equal(full.scope, "complete-store");
  assert.equal(partial.scope, "explicit-exclusions");
  assert.equal(Object.values(s.sync.draftExports!).length, 2);
  assert.equal(
    Object.values(s.sync.draftExports!).find(
      (x) => x.scope === "complete-store",
    )!.snapshot.valid,
    1,
  );
  g.sheets[0].properties.gridProperties.rowCount++;
  assert.throws(() => planDraftSync(g, [e]), /layout changed/);
  assert.throws(() => extractDraft(g, "TX-149", 1), /layout changed/);
});

test("unchanged roster verification timestamps do not churn export revisions", () => {
  const g = grid(),
    e = employee();
  const first = validateDraftExport(g, [e], "TX-149", undefined);
  e.observedAt = new Date().toISOString();
  e.updatedAt = e.observedAt;
  e.revision++;
  assert.deepEqual(validateDraftExport(g, [e], "TX-149", first), first);
});

test("pending assignments sync names-only labels and hidden IDs, export scheduled hours, then bind POS without changing shift identity", () => {
  const g = grid(),
    a = employee(),
    b = {
      ...employee("two"),
      personId: "shared",
      posEmployeeId: "pending:two",
      posIdentityPending: true,
      verification: "awaiting" as const,
    };
  const before = structuredClone(g.sheets[0]);
  const plan = planDraftSync(g, [a, b]);
  assert.deepEqual(g.sheets[0], before);
  const pending = plan.roster.find((r) => r[1] === b.id)!;
  assert.equal(pending[2], "");
  assert.equal(pending[4], "Jamie Carson");
  for (const [i, row] of plan.roster.entries())
    for (const [j, value] of row.entries())
      set(g, ROSTER_ID, i + 2, j + 1, value);
  set(g, MAIN_ID, 23, 14, pending[4]);
  set(g, MAIN_ID, 23, 16, 9 / 24);
  set(g, MAIN_ID, 23, 17, 17 / 24);
  assert.doesNotThrow(() => planDraftSync(g, [a, b]));
  const exported = validateDraftExport(g, [a, b], "TX-149", undefined);
  const shift = exported.snapshot.shifts.find((s) => s.directoryId === b.id)!;
  assert.equal(shift.posIdentityPending, true);
  assert.equal(shift.minutes, 480);
  assert.equal(shift.posEmployeeId, "");
  b.posEmployeeId = "new-store-pos-id";
  b.posIdentityPending = false;
  const bound = validateDraftExport(g, [a, b], "TX-149", exported);
  assert.equal(
    bound.snapshot.shifts.find((s) => s.directoryId === b.id)!.id,
    shift.id,
  );
  assert.equal(
    bound.snapshot.shifts.find((s) => s.directoryId === b.id)!.posEmployeeId,
    "new-store-pos-id",
  );
  assert.ok(bound.snapshot.revision > exported.snapshot.revision);
  b.status = "inactive";
  const inactive = planDraftSync(g, [a, b]);
  assert.ok(inactive.roster.some((r) => r[1] === b.id));
  assert.equal(inactive.active, 1);
});
