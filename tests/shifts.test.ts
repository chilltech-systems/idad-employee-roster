import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import {
  exportShifts,
  laborPreview,
  replaceSnapshot,
  type ShiftInput,
} from "../src/lib/shifts";
const employees = seed().employees;
const cell = {
  sheet: "Texas Schedule",
  row: 12,
  slot: "Monday-1",
  storeId: "TX-DEMO-1",
  directoryId: "demo-2",
  businessDate: "2026-09-07",
  start: "09:00",
  end: "15:00",
  overnight: false,
};
const input = (cells: ShiftInput["cells"] = [cell]): ShiftInput => ({
  workbookId: "fictional",
  weekStart: "2026-09-06",
  revision: 1,
  cells,
});
test("unverified complete identity exports and stable ID survives time edits", () => {
  const a = exportShifts(input(), employees);
  const b = exportShifts(
    { ...input([{ ...cell, start: "10:00" }]), revision: 2 },
    employees,
  );
  assert.equal(a.valid, 1);
  assert.equal(a.shifts[0].minutes, 360);
  assert.equal(a.shifts[0].id, b.shifts[0].id);
  assert.equal(a.shifts[0].timezone, "America/Chicago");
});
test("overnight minutes and split shifts handled", () => {
  const result = exportShifts(
    input([
      { ...cell, start: "22:00", end: "02:00", overnight: true },
      { ...cell, row: 13, slot: "Monday-2", start: "09:00", end: "12:00" },
    ]),
    employees,
  );
  assert.equal(result.valid, 2);
  assert.equal(result.shifts[0].minutes, 240);
  assert.ok(result.shifts[0].end.startsWith("2026-09-08"));
});
test("all populated invalid shifts become exceptions, blank slots ignored", () => {
  const result = exportShifts(
    input([
      { ...cell, directoryId: "" },
      { ...cell, row: 13, end: "" },
      { ...cell, row: 14, directoryId: "demo-3" },
      { ...cell, row: 15, start: "", end: "" },
    ]),
    employees,
  );
  assert.equal(result.populated, 3);
  assert.equal(result.valid, 0);
  assert.equal(result.exceptionCount, 3);
  assert.equal(result.ready, false);
});
test("overlaps and duplicate source slots mark both affected shifts", () => {
  const a = exportShifts(
    input([cell, { ...cell, row: 13, start: "14:00", end: "18:00" }]),
    employees,
  );
  assert.equal(a.exceptionCount, 2);
  const b = exportShifts(input([cell, cell]), employees);
  assert.equal(b.exceptionCount, 2);
});
test("wrong week, incomplete time, zero length, DST gaps and ambiguous hours rejected", () => {
  assert.throws(
    () => exportShifts({ ...input(), weekStart: "2026-09-07" }, employees),
    /Sunday/,
  );
  for (const c of [
    { ...cell, businessDate: "2026-09-14" },
    { ...cell, start: "9am" },
    { ...cell, end: "09:00" },
  ])
    assert.equal(exportShifts(input([c]), employees).exceptionCount, 1);
  assert.equal(
    exportShifts(
      {
        ...input([
          { ...cell, businessDate: "2026-03-08", start: "02:30", end: "04:00" },
        ]),
        weekStart: "2026-03-08",
      },
      employees,
    ).exceptionCount,
    1,
  );
  assert.equal(
    exportShifts(
      {
        ...input([
          { ...cell, businessDate: "2026-11-01", start: "01:30", end: "04:00" },
        ]),
        weekStart: "2026-11-01",
      },
      employees,
    ).exceptionCount,
    1,
  );
});
test("snapshot replacement is idempotent and removes deleted shifts", () => {
  const first = exportShifts(input(), employees);
  assert.deepEqual(replaceSnapshot(first, first), first);
  const empty = exportShifts({ ...input([]), revision: 2 }, employees);
  assert.equal(replaceSnapshot(first, empty).shifts.length, 0);
  assert.throws(() => replaceSnapshot(empty, first), /Stale/);
  assert.throws(
    () =>
      replaceSnapshot(
        first,
        exportShifts(input([{ ...cell, end: "16:00" }]), employees),
      ),
    /newer revision/,
  );
});
test("local labor match uses store/source/ID/date with no name fallback", () => {
  const snapshot = exportShifts(input(), employees);
  const p = {
    id: "p",
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: "00102",
    businessDate: "2026-09-07",
    start: "2026-09-07T09:03:00-05:00",
    end: "2026-09-07T15:02:00-05:00",
  };
  const r = laborPreview(snapshot, [p]);
  assert.equal(r.records[0].result, "matched");
  assert.equal(r.records[0].actualMinutes, 359);
  assert.equal(
    laborPreview(snapshot, [{ ...p, storeId: "TX-DEMO-2" }]).records[0].result,
    "no-punch",
  );
  assert.equal(
    laborPreview(snapshot, [{ ...p, end: null }]).records[0].result,
    "review",
  );
});
test("punch spanning multiple split shifts is review, never silently assigned", () => {
  const snapshot = exportShifts(
    input([
      { ...cell, end: "12:00" },
      { ...cell, row: 13, slot: "Monday-2", start: "13:00", end: "17:00" },
    ]),
    employees,
  );
  const result = laborPreview(snapshot, [
    {
      id: "p",
      storeId: "TX-DEMO-1",
      posSource: "Qu",
      posEmployeeId: "00102",
      businessDate: "2026-09-07",
      start: "2026-09-07T09:00:00-05:00",
      end: "2026-09-07T17:00:00-05:00",
    },
  ]);
  assert.ok(result.records.every((x) => x.result === "review"));
  assert.equal(result.unmatchedPunchIds.length, 1);
});
