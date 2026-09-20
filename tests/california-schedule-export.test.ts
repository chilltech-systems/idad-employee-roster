import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import mapping from "../schedule/mapping.california.json";
import {
  beginCaliforniaDispatch,
  completeCaliforniaDispatch,
  currentChicagoWeek,
  extractCaliforniaLegacyExport,
  prepareCaliforniaDispatch,
  recordCaliforniaCutoff,
  requireCaliforniaScheduleExportToken,
  resolveCurrentCaliforniaSchedule,
} from "../src/lib/california-schedule-export";
import { californiaDraftFingerprint } from "../src/lib/california-draft-schedule";
import type { DraftGrid, GridCell } from "../src/lib/draft-schedule";
import type { Employee } from "../src/lib/model";
import type { ScheduleCatalogEntry } from "../src/lib/schedule-catalog";
import { seed } from "../src/lib/seed";

function set(
  grid: DraftGrid,
  sheetId: number,
  row: number,
  column: number,
  value: string | number,
) {
  const sheet = grid.sheets.find(
      (candidate) => candidate.properties.sheetId === sheetId,
    )!,
    rows = sheet.data![0].rowData!;
  rows[row - 1] ??= { values: [] };
  const cell: GridCell =
    typeof value === "number"
      ? {
          userEnteredValue: { numberValue: value },
          effectiveValue: { numberValue: value },
          formattedValue: String(value),
        }
      : {
          userEnteredValue: { stringValue: value },
          effectiveValue: { stringValue: value },
          formattedValue: value,
        };
  rows[row - 1].values![column - 1] = cell;
}

function employee(storeId: string, index: number): Employee {
  return {
    ...seed().employees[0],
    id: `directory-${index}`,
    personId: `person-${index}`,
    storeId,
    state: "California",
    brand: "Jamba",
    posSource: "Toast",
    posEmployeeId: `toast-${index}`,
    posName: `Jamie Store ${index}`,
    firstName: "Jamie",
    lastName: `Store ${index}`,
    preferredName: "",
    status: "active",
    verification: "confirmed",
  };
}

function serial(date: string) {
  return Math.round(
    DateTime.fromISO(date, { zone: "UTC" }).diff(
      DateTime.fromISO("1899-12-30", { zone: "UTC" }),
      "days",
    ).days,
  );
}

function fixture() {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index + 1),
    ),
    grid: DraftGrid = {
      spreadsheetId: mapping.spreadsheetId,
      sheets: [
        {
          properties: {
            sheetId: mapping.schedule.sheetId,
            title: mapping.schedule.sheet,
            gridProperties: {
              rowCount: mapping.schedule.rowCount,
              columnCount: mapping.schedule.columnCount,
            },
          },
          data: [
            {
              rowData: Array.from({ length: 430 }, () => ({ values: [] })),
            },
          ],
        },
        {
          properties: {
            sheetId: mapping.master.sheetId,
            title: mapping.master.sheet,
            gridProperties: {
              rowCount: mapping.master.rowCount,
              columnCount: mapping.master.columnCount,
            },
          },
          data: [
            {
              rowData: Array.from({ length: 1000 }, () => ({ values: [] })),
            },
          ],
        },
      ],
    },
    weekStart = "2026-09-20";
  mapping.schedule.days.forEach((day, index) =>
    set(
      grid,
      mapping.schedule.sheetId,
      mapping.schedule.weekStart.row,
      day.dateColumn,
      serial(
        DateTime.fromISO(weekStart, { zone: "America/Chicago" })
          .plus({ days: index })
          .toISODate()!,
      ),
    ),
  );
  mapping.stores.forEach((store, index) => {
    const item = employees[index],
      label = `Jamie ${index + 1}`;
    set(grid, mapping.master.sheetId, 11, store.nameColumn, store.sourceHeader);
    set(grid, mapping.master.sheetId, 13, store.nameColumn, "Name");
    set(grid, mapping.master.sheetId, 13, store.idColumn, "ID");
    set(grid, mapping.master.sheetId, 15, store.nameColumn, label);
    set(grid, mapping.master.sheetId, 15, store.idColumn, item.id);
    set(
      grid,
      mapping.schedule.sheetId,
      store.scheduleStartRow,
      mapping.schedule.nameColumn,
      label,
    );
    set(
      grid,
      mapping.schedule.sheetId,
      store.scheduleStartRow,
      mapping.schedule.days[0].startColumn,
      8 / 24,
    );
    set(
      grid,
      mapping.schedule.sheetId,
      store.scheduleStartRow,
      mapping.schedule.days[0].endColumn,
      12 / 24,
    );
  });
  const target: ScheduleCatalogEntry = {
    state: "california",
    targetKey: "schedule:california-2026-09-20",
    scheduleId: "california-2026-09-20",
    sheetId: mapping.spreadsheetId,
    sheetName: "California Schedule - 09.20 - 09.26",
    sheetUrl: `https://docs.google.com/spreadsheets/d/${mapping.spreadsheetId}/edit`,
    weekStart,
    weekEnd: "2026-09-26",
  };
  return { employees, grid, target };
}

test("current California week uses America/Chicago across DST Sundays", () => {
  assert.deepEqual(currentChicagoWeek(new Date("2026-03-08T11:15:00Z")), {
    weekStart: "2026-03-08",
    weekEnd: "2026-03-14",
  });
  assert.deepEqual(currentChicagoWeek(new Date("2026-11-01T11:15:00Z")), {
    weekStart: "2026-11-01",
    weekEnd: "2026-11-07",
  });
});

test("automatic catalog selection requires exactly one current California schedule", () => {
  const { target } = fixture();
  assert.equal(
    resolveCurrentCaliforniaSchedule([target], target.weekStart, target.weekEnd)
      .sheetId,
    target.sheetId,
  );
  assert.throws(
    () =>
      resolveCurrentCaliforniaSchedule([], target.weekStart, target.weekEnd),
    /not available yet/,
  );
  assert.throws(
    () =>
      resolveCurrentCaliforniaSchedule(
        [target, { ...target, scheduleId: "duplicate" }],
        target.weekStart,
        target.weekEnd,
      ),
    /Multiple California schedules/,
  );
});

test("California extraction returns the legacy webhook contract for all six stores", () => {
  const { employees, grid, target } = fixture(),
    result = extractCaliforniaLegacyExport(grid, employees, target);
  assert.equal(result.ready, true, JSON.stringify(result.issues));
  assert.equal(result.shiftCount, 6);
  assert.deepEqual(result.countsByStore, {
    "JJ-025": 1,
    "JJ-125": 1,
    "JJ-104833": 1,
    "JJ-171": 1,
    "JJ-548": 1,
    "JJ-552": 1,
  });
  assert.deepEqual(result.payload?.schedule[0], {
    row_number: 21,
    "Store ID": "jj-25",
    Date: "9/20/2026",
    "Employee ID": "toast-1",
    "Employee Name": "Jamie Store 1",
    "Clock-in time": "8:00:00",
    "Clock-out time": "12:00:00",
    "Total Hours": "4:00:00",
    week_start: "2026-09-20",
    week_end: "2026-09-26",
    week_num: 39,
  });
  assert.deepEqual(Object.keys(result.payload || {}), [
    "state",
    "brand",
    "week_num",
    "week_start",
    "week_end",
    "schedule",
  ]);
});

test("California extraction carries one confirmed Toast ID to a linked multi-store assignment", () => {
  const { employees, grid, target } = fixture(),
    source = employees.find((employee) => employee.storeId === "JJ-548")!,
    destination = employees.find((employee) => employee.storeId === "JJ-552")!;
  destination.personId = source.personId;
  destination.posEmployeeId = `pending:${destination.id}`;
  destination.posIdentityPending = true;
  destination.verification = "awaiting";
  const destinationStore = mapping.stores.find(
    (store) => store.storeId === destination.storeId,
  )!;
  set(
    grid,
    mapping.schedule.sheetId,
    destinationStore.scheduleStartRow,
    mapping.schedule.days[0].startColumn,
    12 / 24,
  );
  set(
    grid,
    mapping.schedule.sheetId,
    destinationStore.scheduleStartRow,
    mapping.schedule.days[0].endColumn,
    16 / 24,
  );

  const result = extractCaliforniaLegacyExport(grid, employees, target),
    shift = result.payload?.schedule.find(
      (candidate) => candidate["Store ID"] === "jj-552",
    );
  assert.equal(result.ready, true, JSON.stringify(result.issues));
  assert.equal(shift?.["Employee ID"], source.posEmployeeId);
});

test("California extraction blocks incomplete and unbound shifts", () => {
  const { employees, grid, target } = fixture(),
    store = mapping.stores[0];
  set(
    grid,
    mapping.schedule.sheetId,
    store.scheduleStartRow,
    mapping.schedule.days[0].endColumn,
    "",
  );
  set(
    grid,
    mapping.schedule.sheetId,
    store.scheduleStartRow,
    mapping.schedule.nameColumn,
    "Unknown Person",
  );
  const result = extractCaliforniaLegacyExport(grid, employees, target);
  assert.equal(result.ready, false);
  assert.equal(result.payload, undefined);
  assert.ok(
    result.issues.some((issue) =>
      issue.reason.includes("incomplete start or end time"),
    ),
  );
});

test("California stable-read fingerprint includes dates and shift times", () => {
  const { grid } = fixture(),
    before = californiaDraftFingerprint(grid);
  set(
    grid,
    mapping.schedule.sheetId,
    mapping.stores[0].scheduleStartRow,
    mapping.schedule.days[0].startColumn,
    9 / 24,
  );
  assert.notEqual(californiaDraftFingerprint(grid), before);
});

test("dispatch ledger prevents replay and preserves ambiguous outcomes", () => {
  const state = seed(),
    { employees, grid, target } = fixture(),
    candidate = extractCaliforniaLegacyExport(grid, employees, target),
    prepared = prepareCaliforniaDispatch(
      state,
      candidate,
      "2026-09-20T10:15:00.000Z",
    );
  assert.equal(prepared.status, "prepared");
  assert.ok("revision" in prepared);
  assert.equal(prepared.revision, 1);
  const begun = beginCaliforniaDispatch(
    state,
    target.weekStart,
    candidate.fingerprint,
    "2026-09-20T10:16:00.000Z",
  );
  const completed = completeCaliforniaDispatch(
    state,
    {
      weekStart: target.weekStart,
      fingerprint: candidate.fingerprint,
      attemptId: begun.attemptId,
      outcome: "succeeded",
      processed: 6,
      message: "Schedule processed",
    },
    "2026-09-20T10:17:00.000Z",
  );
  assert.equal(completed.dispatch.status, "succeeded");
  const replay = prepareCaliforniaDispatch(state, candidate);
  assert.equal(replay.ready, false);
  assert.equal(replay.terminal, true);
  assert.equal(replay.status, "succeeded");
});

test("processed-count mismatches are rejected before success is recorded", () => {
  const state = seed(),
    { employees, grid, target } = fixture(),
    candidate = extractCaliforniaLegacyExport(grid, employees, target);
  prepareCaliforniaDispatch(state, candidate);
  const begun = beginCaliforniaDispatch(
    state,
    target.weekStart,
    candidate.fingerprint,
  );
  assert.throws(
    () =>
      completeCaliforniaDispatch(state, {
        weekStart: target.weekStart,
        fingerprint: candidate.fingerprint,
        attemptId: begun.attemptId,
        outcome: "succeeded",
        processed: 5,
      }),
    /processed count did not match/,
  );
  const ambiguous = completeCaliforniaDispatch(state, {
    weekStart: target.weekStart,
    fingerprint: candidate.fingerprint,
    attemptId: begun.attemptId,
    outcome: "ambiguous",
    message: "Webhook response was uncertain.",
  });
  assert.equal(ambiguous.dispatch.status, "ambiguous");
});

test("cutoff requests exactly one notification", () => {
  const state = seed(),
    first = recordCaliforniaCutoff(
      state,
      "2026-09-20",
      "2026-09-26",
      "Schedule unavailable",
      "2026-09-20T13:00:00.000Z",
    ),
    second = recordCaliforniaCutoff(
      state,
      "2026-09-20",
      "2026-09-26",
      "Schedule unavailable",
      "2026-09-20T13:01:00.000Z",
    );
  assert.equal(first.notify, true);
  assert.equal(second.notify, false);
});

test("California machine endpoint requires its dedicated bearer token", () => {
  const token = "a".repeat(40),
    hash = createHash("sha256").update(token).digest("hex");
  assert.doesNotThrow(() =>
    requireCaliforniaScheduleExportToken(`Bearer ${token}`, hash),
  );
  assert.throws(
    () =>
      requireCaliforniaScheduleExportToken("Bearer " + "b".repeat(40), hash),
    /authorization failed/,
  );
});
