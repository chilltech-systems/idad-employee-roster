import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  displayName,
  identityKey,
  personId,
  resolvedPosIdentity,
  type Employee,
} from "./model";
const cellSchema = z
  .object({
    sheet: z.string().min(1),
    row: z.number().int().positive(),
    slot: z.string().min(1),
    storeId: z.string().min(1),
    directoryId: z.string(),
    businessDate: z.string(),
    start: z.string(),
    end: z.string(),
    overnight: z.boolean().default(false),
  })
  .strict();
export const shiftInputSchema = z
  .object({
    workbookId: z.string().min(1),
    weekStart: z.string(),
    revision: z.number().int().positive(),
    cells: z.array(cellSchema),
  })
  .strict();
export type ShiftInput = z.input<typeof shiftInputSchema>;
export type Shift = {
  personId?: string;
  posIdentityPending?: boolean;
  id: string;
  directoryId: string;
  storeId: string;
  posSource: string;
  posEmployeeId: string;
  displayName: string;
  posName: string;
  businessDate: string;
  start: string;
  end: string;
  minutes: number;
  timezone: "America/Chicago";
  source: { workbookId: string; sheet: string; row: number; slot: string };
  revision: number;
};
export type Exception = {
  sourceIndex: number;
  sheet: string;
  row: number;
  slot: string;
  reason: string;
};
const zone = "America/Chicago";
function localTime(date: string, time: string) {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Use 24-hour HH:mm times.");
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd HH:mm") !== `${date} ${time}`)
    throw new Error("Time is invalid or falls in the daylight-saving gap.");
  if (dt.getPossibleOffsets().length !== 1)
    throw new Error("Ambiguous daylight-saving time requires review.");
  return dt;
}
export function exportShifts(raw: unknown, employees: Employee[]) {
  const input = shiftInputSchema.parse(raw);
  const week = DateTime.fromISO(input.weekStart, { zone });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart) ||
    !week.isValid ||
    week.weekday !== 7
  )
    throw new Error("Week must start on a Sunday.");
  const candidates: { shift: Shift; index: number }[] = [];
  const issues = new Map<number, string[]>();
  let populated = 0;
  const issue = (i: number, text: string) =>
    issues.set(i, [...(issues.get(i) || []), text]);
  input.cells.forEach((cell, index) => {
    if (!cell.start.trim() && !cell.end.trim()) return;
    populated++;
    try {
      if (!cell.start.trim() || !cell.end.trim())
        throw new Error("Shift has an incomplete start or end time.");
      const employee = employees.find(
        (e) => e.id === cell.directoryId && e.storeId === cell.storeId,
      );
      if (!employee)
        throw new Error("A valid directory and POS identity is required.");
      const identity = resolvedPosIdentity(employee, employees);
      if (!identity.posEmployeeId && !identity.posIdentityPending)
        throw new Error("A valid directory and POS identity is required.");
      if (employee.verification === "review")
        throw new Error("Conflicting POS identity requires review.");
      const date = DateTime.fromISO(cell.businessDate, { zone });
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(cell.businessDate) ||
        !date.isValid ||
        date < week ||
        date >= week.plus({ days: 7 })
      )
        throw new Error(
          "Business date is outside the selected Sunday–Saturday week.",
        );
      const start = localTime(cell.businessDate, cell.start);
      const end = localTime(
        date.plus({ days: cell.overnight ? 1 : 0 }).toISODate()!,
        cell.end,
      );
      const minutes = end.diff(start, "minutes").minutes;
      if (minutes <= 0 || minutes > 24 * 60)
        throw new Error(
          "End must follow start. Mark overnight shifts explicitly.",
        );
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            input.workbookId,
            cell.sheet,
            cell.row,
            cell.slot,
            cell.businessDate,
          ]),
        )
        .digest("hex")
        .slice(0, 32);
      candidates.push({
        index,
        shift: {
          id,
          directoryId: employee.id,
          personId: personId(employee),
          posIdentityPending: identity.posIdentityPending,
          storeId: cell.storeId,
          posSource: employee.posSource,
          posEmployeeId: identity.posEmployeeId,
          displayName: displayName(employee),
          posName: employee.posName,
          businessDate: cell.businessDate,
          start: start.toISO()!,
          end: end.toISO()!,
          minutes,
          timezone: zone,
          source: {
            workbookId: input.workbookId,
            sheet: cell.sheet,
            row: cell.row,
            slot: cell.slot,
          },
          revision: input.revision,
        },
      });
    } catch (e) {
      issue(index, (e as Error).message);
    }
  });
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i],
        b = candidates[j];
      if (a.shift.id === b.shift.id) {
        issue(a.index, "Duplicate source shift slot.");
        issue(b.index, "Duplicate source shift slot.");
      }
      if (
        (a.shift.personId || a.shift.directoryId) ===
          (b.shift.personId || b.shift.directoryId) &&
        Date.parse(a.shift.start) < Date.parse(b.shift.end) &&
        Date.parse(b.shift.start) < Date.parse(a.shift.end)
      ) {
        issue(a.index, "Overlapping shifts for this POS identity.");
        issue(b.index, "Overlapping shifts for this POS identity.");
      }
    }
  const shifts = candidates
    .filter((x) => !issues.has(x.index))
    .map((x) => x.shift);
  const exceptions: Exception[] = [...issues].map(([sourceIndex, reasons]) => ({
    sourceIndex,
    sheet: input.cells[sourceIndex].sheet,
    row: input.cells[sourceIndex].row,
    slot: input.cells[sourceIndex].slot,
    reason: [...new Set(reasons)].join(" "),
  }));
  if (shifts.length + exceptions.length !== populated)
    throw new Error("Source reconciliation failed.");
  return {
    version: 1,
    workbookId: input.workbookId,
    weekStart: input.weekStart,
    revision: input.revision,
    timezone: zone,
    populated,
    valid: shifts.length,
    exceptionCount: exceptions.length,
    ready: exceptions.length === 0,
    shifts,
    exceptions,
  };
}
export type ShiftSnapshot = ReturnType<typeof exportShifts>;
export function replaceSnapshot(
  previous: ShiftSnapshot | undefined,
  next: ShiftSnapshot,
) {
  if (!next.ready)
    throw new Error(
      "Resolve all shift exceptions before accepting a snapshot.",
    );
  if (
    previous &&
    (previous.workbookId !== next.workbookId ||
      previous.weekStart !== next.weekStart)
  )
    throw new Error("Snapshot belongs to a different workbook/week.");
  if (previous && next.revision < previous.revision)
    throw new Error("Stale export revision.");
  if (
    previous &&
    next.revision === previous.revision &&
    JSON.stringify(previous) !== JSON.stringify(next)
  )
    throw new Error("Changed snapshot requires a newer revision.");
  return structuredClone(next);
}
export const punchSchema = z
  .object({
    id: z.string(),
    storeId: z.string(),
    posSource: z.string(),
    posEmployeeId: z.string().min(1),
    businessDate: z.string(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type Punch = z.infer<typeof punchSchema>;
export function laborPreview(snapshot: ShiftSnapshot, raw: unknown) {
  if (!snapshot.ready)
    throw new Error(
      "Resolve export exceptions before generating a labor preview.",
    );
  const punches = z.array(punchSchema).parse(raw);
  const used = new Set<string>();
  if (new Set(punches.map((p) => p.id)).size !== punches.length)
    throw new Error("Duplicate punch IDs require review.");
  const records = snapshot.shifts.map((shift) => {
    if (shift.posIdentityPending || !shift.posEmployeeId)
      return {
        shiftId: shift.id,
        displayName: shift.displayName,
        result: "review",
        reason: "POS verification pending at the scheduled store",
        scheduledMinutes: shift.minutes,
      };
    const eligible = punches.filter(
      (p) =>
        identityKey(p) === identityKey(shift) &&
        p.businessDate === shift.businessDate,
    );
    const overlapping = eligible.filter(
      (p) =>
        p.end &&
        Date.parse(p.start) < Date.parse(shift.end) &&
        Date.parse(p.end) > Date.parse(shift.start),
    );
    const sameDayShifts = snapshot.shifts.filter(
      (s) =>
        identityKey(s) === identityKey(shift) &&
        s.businessDate === shift.businessDate,
    );
    const candidates = overlapping.length
      ? overlapping
      : sameDayShifts.length === 1
        ? eligible
        : [];
    if (eligible.some((p) => p.end === null))
      return {
        shiftId: shift.id,
        displayName: shift.displayName,
        result: "review",
        reason: "Missing clock-out",
        scheduledMinutes: shift.minutes,
      };
    if (candidates.length !== 1)
      return {
        shiftId: shift.id,
        displayName: shift.displayName,
        result: candidates.length ? "review" : "no-punch",
        reason: candidates.length
          ? "Multiple punches require review"
          : "No unambiguous matching punch",
        scheduledMinutes: shift.minutes,
      };
    const punch = candidates[0];
    const otherMatches = snapshot.shifts.filter(
      (s) =>
        identityKey(s) === identityKey(punch) &&
        s.businessDate === punch.businessDate &&
        Date.parse(punch.start) < Date.parse(s.end) &&
        Date.parse(punch.end!) > Date.parse(s.start),
    );
    if (otherMatches.length > 1 || used.has(punch.id))
      return {
        shiftId: shift.id,
        displayName: shift.displayName,
        result: "review",
        reason: "Punch spans multiple scheduled shifts",
        scheduledMinutes: shift.minutes,
      };
    const actualMinutes =
      (Date.parse(punch.end!) - Date.parse(punch.start)) / 60000;
    if (actualMinutes <= 0)
      return {
        shiftId: shift.id,
        displayName: shift.displayName,
        result: "review",
        reason: "Invalid punch interval",
        scheduledMinutes: shift.minutes,
      };
    used.add(punch.id);
    return {
      shiftId: shift.id,
      displayName: shift.displayName,
      result: "matched",
      punchId: punch.id,
      scheduledMinutes: shift.minutes,
      actualMinutes,
      startDifferenceMinutes:
        (Date.parse(punch.start) - Date.parse(shift.start)) / 60000,
      endDifferenceMinutes:
        (Date.parse(punch.end!) - Date.parse(shift.end)) / 60000,
    };
  });
  return {
    kind: "local-identity-and-time-preview",
    weekStart: snapshot.weekStart,
    records,
    unmatchedPunchIds: punches.filter((p) => !used.has(p.id)).map((p) => p.id),
    note: "Diagnostic preview only. Approved labor-report attendance thresholds and PDF calculations have not been changed.",
  };
}
