import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import mapping from "../../schedule/mapping.california.json";
import {
  californiaMasterFromGrid,
  stableCaliforniaDraft,
} from "./california-draft-schedule";
import {
  cell,
  textValue,
  type DraftGrid,
  type GridCell,
} from "./draft-schedule";
import { californiaDraftClient } from "./google-california-draft";
import {
  Problem,
  resolvedPosIdentity,
  type CaliforniaScheduleDispatch,
  type Employee,
  type State,
} from "./model";
import {
  readScheduleCatalog,
  type ScheduleCatalogEntry,
} from "./schedule-catalog";
import { exportShifts, type ShiftInput } from "./shifts";

const zone = "America/Chicago";
const stateName = "california" as const;
const brand = "jamba" as const;

export const californiaScheduleExportRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("prepare") }).strict(),
    z
      .object({
        action: z.literal("begin"),
        weekStart: z.iso.date(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    z
      .object({
        action: z.literal("complete"),
        weekStart: z.iso.date(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        attemptId: z.uuid(),
        outcome: z.enum(["succeeded", "ambiguous"]),
        processed: z.number().int().nonnegative().optional(),
        message: z.string().trim().max(300).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("cutoff"),
        message: z.string().trim().max(300).optional(),
      })
      .strict(),
  ],
);

export type LegacyCaliforniaScheduleRow = {
  row_number: number;
  "Store ID": string;
  Date: string;
  "Employee ID": string;
  "Employee Name": string;
  "Clock-in time": string;
  "Clock-out time": string;
  "Total Hours": string;
  week_start: string;
  week_end: string;
  week_num: number;
};

export type LegacyCaliforniaSchedulePayload = {
  state: "CA";
  brand: "jamba";
  week_num: number;
  week_start: string;
  week_end: string;
  schedule: LegacyCaliforniaScheduleRow[];
};

export type CaliforniaExportIssue = {
  storeId?: string;
  row?: number;
  day?: string;
  reason: string;
};

export type CaliforniaExportCandidate = {
  version: 1;
  ready: boolean;
  target: {
    scheduleId: string;
    workbookId: string;
    sheetName: string;
    weekStart: string;
    weekEnd: string;
  };
  fingerprint: string;
  countsByStore: Record<string, number>;
  shiftCount: number;
  issues: CaliforniaExportIssue[];
  payload?: LegacyCaliforniaSchedulePayload;
};

export type CaliforniaReportingExportResult = {
  storeId: string;
  status: "ready" | "blocked";
  issues: CaliforniaExportIssue[];
  export: CaliforniaExportCandidate | null;
};

export function currentChicagoWeek(now = new Date()) {
  const local = DateTime.fromJSDate(now, { zone }).startOf("day");
  const week = local.minus({ days: local.weekday % 7 });
  return {
    weekStart: week.toISODate()!,
    weekEnd: week.plus({ days: 6 }).toISODate()!,
  };
}

export function resolveCurrentCaliforniaSchedule(
  catalog: ScheduleCatalogEntry[],
  weekStart: string,
  weekEnd: string,
) {
  const matches = catalog.filter(
    (entry) => entry.weekStart === weekStart && entry.weekEnd === weekEnd,
  );
  if (matches.length !== 1)
    throw new Problem(
      409,
      matches.length
        ? `Multiple California schedules match ${weekStart}.`
        : `California schedule ${weekStart} is not available yet.`,
    );
  return matches[0];
}

function googleDate(grid: DraftGrid, column: number) {
  const source = cell(
      grid,
      mapping.schedule.sheetId,
      mapping.schedule.weekStart.row,
      column,
    ),
    serial = source.effectiveValue?.numberValue;
  if (serial !== undefined && Number.isInteger(serial))
    return DateTime.fromISO("1899-12-30", { zone: "UTC" })
      .plus({ days: serial })
      .toISODate()!;
  const value = textValue(source).trim(),
    parsed = DateTime.fromFormat(value, "M/d/yyyy", { zone });
  if (parsed.isValid) return parsed.toISODate()!;
  return value;
}

function scheduleTime(source: GridCell) {
  const numeric = source.effectiveValue?.numberValue;
  if (numeric !== undefined) {
    if (
      numeric < 0 ||
      numeric >= 1 ||
      Math.abs(numeric * 1440 - Math.round(numeric * 1440)) > 0.001
    )
      return String(numeric);
    const minutes = Math.round(numeric * 1440);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (source.effectiveValue?.errorValue) return "#CELL_ERROR";
  const value = textValue(source).trim();
  if (!value) return "";
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM))?$/i.exec(value);
  if (!match) return value;
  let hour = Number(match[1]);
  if (match[3]) {
    if (hour < 1 || hour > 12) return value;
    hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function minutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function legacyTime(value: string) {
  const parsed = DateTime.fromISO(value, { setZone: true }).setZone(zone);
  return `${parsed.hour}:${String(parsed.minute).padStart(2, "0")}:00`;
}

function legacyDuration(value: number) {
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}:00`;
}

function legacyWeekNumber(weekStart: string) {
  return DateTime.fromISO(weekStart, { zone }).weekNumber + 1;
}

export function extractCaliforniaLegacyExport(
  grid: DraftGrid,
  employees: Employee[],
  target: ScheduleCatalogEntry,
  requestedStoreIds?: string[],
): CaliforniaExportCandidate {
  const requested = requestedStoreIds?.length
      ? new Set(requestedStoreIds.map((value) => value.toUpperCase()))
      : null,
    activeStores = requested
      ? mapping.stores.filter((store) => requested.has(store.storeId))
      : mapping.stores;
  if (requested && activeStores.length !== requested.size)
    throw new Problem(400, "Unknown California Jamba store scope.");
  const master = californiaMasterFromGrid(grid, target.sheetId),
    issues: CaliforniaExportIssue[] = [],
    labels = new Map<string, string>(),
    directoryClaims = new Set<string>();
  for (const entry of master) {
    if (requested && !requested.has(entry.storeId)) continue;
    const labelKey = `${entry.storeId}|${entry.label}`,
      directoryKey = `${entry.storeId}|${entry.directoryId}`;
    if (labels.has(labelKey))
      issues.push({
        storeId: entry.storeId,
        reason: "Duplicate employee label in the California master.",
      });
    if (directoryClaims.has(directoryKey))
      issues.push({
        storeId: entry.storeId,
        reason: "Duplicate directory identity in the California master.",
      });
    labels.set(labelKey, entry.directoryId);
    directoryClaims.add(directoryKey);
  }

  const expectedWeek = DateTime.fromISO(target.weekStart, { zone });
  mapping.schedule.days.forEach((day, index) => {
    const expected = expectedWeek.plus({ days: index }).toISODate(),
      actual = googleDate(grid, day.dateColumn);
    if (actual !== expected)
      issues.push({
        day: day.name,
        reason: `${day.name} date does not match ${expected}.`,
      });
  });

  const cells: ShiftInput["cells"] = [];
  for (const [dayIndex, day] of mapping.schedule.days.entries()) {
    const businessDate = expectedWeek.plus({ days: dayIndex }).toISODate()!;
    for (const store of activeStores)
      for (
        let row = store.scheduleStartRow;
        row <= store.scheduleEndRow;
        row++
      ) {
        const selected = textValue(
            cell(
              grid,
              mapping.schedule.sheetId,
              row,
              mapping.schedule.nameColumn,
            ),
          ).trim(),
          start = scheduleTime(
            cell(grid, mapping.schedule.sheetId, row, day.startColumn),
          ),
          end = scheduleTime(
            cell(grid, mapping.schedule.sheetId, row, day.endColumn),
          ),
          startMinutes = minutes(start),
          endMinutes = minutes(end);
        cells.push({
          sheet: mapping.schedule.sheet,
          row,
          slot: day.name.toLocaleLowerCase("en-US"),
          storeId: store.storeId,
          directoryId: labels.get(`${store.storeId}|${selected}`) || "",
          businessDate,
          start,
          end,
          overnight:
            startMinutes !== undefined &&
            endMinutes !== undefined &&
            endMinutes < startMinutes,
        });
      }
  }

  const snapshot = exportShifts(
    {
      workbookId: target.sheetId,
      weekStart: target.weekStart,
      revision: 1,
      cells,
    },
    employees,
  );
  for (const exception of snapshot.exceptions) {
    const source = cells[exception.sourceIndex];
    issues.push({
      storeId: source.storeId,
      row: source.row,
      day: source.slot,
      reason: exception.reason,
    });
  }
  for (const shift of snapshot.shifts) {
    const identity = employees.find(
      (employee) =>
        employee.id === shift.directoryId && employee.storeId === shift.storeId,
    );
    if (
      !identity ||
      identity.status !== "active" ||
      identity.verification === "review" ||
      resolvedPosIdentity(identity, employees).posIdentityPending ||
      !shift.posEmployeeId
    )
      issues.push({
        storeId: shift.storeId,
        row: shift.source.row,
        day: shift.source.slot,
        reason: "An active, exact directory and POS identity is required.",
      });
  }
  if (!snapshot.valid)
    issues.push({ reason: "No validated California shifts were found." });

  const countsByStore = Object.fromEntries(
      activeStores.map((store) => [
        store.storeId,
        snapshot.shifts.filter((shift) => shift.storeId === store.storeId)
          .length,
      ]),
    ),
    weekNum = legacyWeekNumber(target.weekStart),
    storeHeaders = new Map(
      activeStores.map((store) => [store.storeId, store.sourceHeader]),
    ),
    employeeById = new Map(
      employees.map((employee) => [employee.id, employee]),
    ),
    schedule: LegacyCaliforniaScheduleRow[] = snapshot.shifts.map((shift) => {
      const employee = employeeById.get(shift.directoryId)!;
      return {
        row_number: shift.source.row,
        "Store ID": storeHeaders.get(shift.storeId)!,
        Date: DateTime.fromISO(shift.businessDate, { zone }).toFormat(
          "M/d/yyyy",
        ),
        "Employee ID": shift.posEmployeeId,
        "Employee Name": employee.posName,
        "Clock-in time": legacyTime(shift.start),
        "Clock-out time": legacyTime(shift.end),
        "Total Hours": legacyDuration(shift.minutes),
        week_start: target.weekStart,
        week_end: target.weekEnd,
        week_num: weekNum,
      };
    }),
    payload: LegacyCaliforniaSchedulePayload = {
      state: "CA",
      brand,
      week_num: weekNum,
      week_start: target.weekStart,
      week_end: target.weekEnd,
      schedule,
    },
    fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          scheduleId: target.scheduleId,
          workbookId: target.sheetId,
          payload,
        }),
      )
      .digest("hex"),
    uniqueIssues = [
      ...new Map(
        issues.map((issue) => [JSON.stringify(issue), issue]),
      ).values(),
    ];
  return {
    version: 1,
    ready: uniqueIssues.length === 0,
    target: {
      scheduleId: target.scheduleId,
      workbookId: target.sheetId,
      sheetName: target.sheetName,
      weekStart: target.weekStart,
      weekEnd: target.weekEnd,
    },
    fingerprint,
    countsByStore,
    shiftCount: schedule.length,
    issues: uniqueIssues,
    ...(uniqueIssues.length ? {} : { payload }),
  };
}

/**
 * Produces one report-time result per requested store. Unlike the Sunday
 * publisher, this is deliberately not an all-stores gate: a report runner can
 * continue other stores while retaining exact evidence for the blocked store.
 * It does not create or alter a California dispatch record.
 */
export function finalizeCaliforniaReportingExports(
  grid: DraftGrid,
  employees: Employee[],
  target: ScheduleCatalogEntry,
  storeIds: string[],
) {
  const requested = [...new Set(storeIds.map((value) => value.toUpperCase()))];
  if (!requested.length)
    throw new Problem(400, "At least one California store is required.");
  return {
    version: 1 as const,
    state: stateName,
    brand,
    weekStart: target.weekStart,
    generatedAt: new Date().toISOString(),
    results: requested.map((storeId): CaliforniaReportingExportResult => {
      const candidate = extractCaliforniaLegacyExport(
        grid,
        employees,
        target,
        [storeId],
      );
      return candidate.ready && candidate.payload
        ? { storeId, status: "ready", issues: [], export: candidate }
        : { storeId, status: "blocked", issues: candidate.issues, export: null };
    }),
  };
}

export async function buildCurrentCaliforniaExport(
  now = new Date(),
  dependencies: {
    readCatalog?: typeof readScheduleCatalog;
    readGrid?: (workbookId: string) => Promise<DraftGrid>;
    employees: Employee[];
  },
) {
  const { weekStart, weekEnd } = currentChicagoWeek(now),
    catalog = await (dependencies.readCatalog || readScheduleCatalog)(
      stateName,
    ),
    target = resolveCurrentCaliforniaSchedule(catalog, weekStart, weekEnd),
    grid = dependencies.readGrid
      ? await dependencies.readGrid(target.sheetId)
      : await stableCaliforniaDraft(
          await californiaDraftClient(fetch, target.sheetId),
          target.sheetId,
        );
  return extractCaliforniaLegacyExport(grid, dependencies.employees, target);
}

export function californiaDispatchKey(weekStart: string) {
  return [stateName, brand, weekStart].join(":");
}

export function prepareCaliforniaDispatch(
  state: State,
  candidate: CaliforniaExportCandidate,
  at = new Date().toISOString(),
) {
  if (!candidate.ready || !candidate.payload)
    return {
      ...candidate,
      terminal: false as const,
      status: "blocked" as const,
    };
  const key = californiaDispatchKey(candidate.target.weekStart),
    previous = state.sync.californiaScheduleDispatches?.[key];
  if (
    previous &&
    ["dispatching", "succeeded", "ambiguous"].includes(previous.status)
  )
    return {
      version: 1 as const,
      ready: false as const,
      terminal: true as const,
      status: previous.status,
      dispatch: structuredClone(previous),
    };
  const revision =
      previous?.fingerprint === candidate.fingerprint
        ? previous.revision
        : (previous?.revision || 0) + 1,
    record: CaliforniaScheduleDispatch = {
      key,
      state: stateName,
      brand,
      weekStart: candidate.target.weekStart,
      weekEnd: candidate.target.weekEnd,
      status: "prepared",
      revision,
      preparedAt: previous?.preparedAt || at,
      workbookId: candidate.target.workbookId,
      scheduleId: candidate.target.scheduleId,
      fingerprint: candidate.fingerprint,
      shiftCount: candidate.shiftCount,
      countsByStore: structuredClone(candidate.countsByStore),
    };
  state.sync.californiaScheduleDispatches ??= {};
  state.sync.californiaScheduleDispatches[key] = record;
  return {
    ...candidate,
    terminal: false as const,
    status: record.status,
    revision,
  };
}

export function beginCaliforniaDispatch(
  state: State,
  weekStart: string,
  fingerprint: string,
  at = new Date().toISOString(),
) {
  const record =
    state.sync.californiaScheduleDispatches?.[californiaDispatchKey(weekStart)];
  if (!record || record.status !== "prepared")
    throw new Problem(409, "California schedule is not prepared for dispatch.");
  if (record.fingerprint !== fingerprint)
    throw new Problem(409, "California schedule fingerprint changed.");
  record.status = "dispatching";
  record.dispatchingAt = at;
  record.attemptId = randomUUID();
  record.message = undefined;
  return {
    ok: true,
    attemptId: record.attemptId,
    weekStart: record.weekStart,
    fingerprint: record.fingerprint,
    shiftCount: record.shiftCount,
  };
}

export function completeCaliforniaDispatch(
  state: State,
  input: {
    weekStart: string;
    fingerprint: string;
    attemptId: string;
    outcome: "succeeded" | "ambiguous";
    processed?: number;
    message?: string;
  },
  at = new Date().toISOString(),
) {
  const record =
    state.sync.californiaScheduleDispatches?.[
      californiaDispatchKey(input.weekStart)
    ];
  if (
    !record ||
    record.status !== "dispatching" ||
    record.fingerprint !== input.fingerprint ||
    record.attemptId !== input.attemptId
  )
    throw new Problem(409, "California dispatch receipt did not match.");
  if (input.outcome === "succeeded" && input.processed !== record.shiftCount)
    throw new Problem(409, "Webhook processed count did not match the export.");
  record.status = input.outcome;
  record.completedAt = at;
  record.processed = input.processed;
  record.message = input.message?.slice(0, 300);
  return { ok: true, dispatch: structuredClone(record) };
}

export function recordCaliforniaCutoff(
  state: State,
  weekStart: string,
  weekEnd: string,
  message: string,
  at = new Date().toISOString(),
) {
  const key = californiaDispatchKey(weekStart),
    previous = state.sync.californiaScheduleDispatches?.[key];
  if (previous?.status === "succeeded")
    return { ok: true, notify: false, dispatch: structuredClone(previous) };
  if (previous?.cutoffNotificationAt)
    return { ok: false, notify: false, dispatch: structuredClone(previous) };
  const record: CaliforniaScheduleDispatch = previous || {
    key,
    state: stateName,
    brand,
    weekStart,
    weekEnd,
    status: "failed",
    revision: 0,
  };
  if (record.status === "dispatching") record.status = "ambiguous";
  else if (record.status !== "ambiguous") record.status = "failed";
  record.completedAt = at;
  record.message = message.slice(0, 300);
  record.cutoffNotificationAt = at;
  state.sync.californiaScheduleDispatches ??= {};
  state.sync.californiaScheduleDispatches[key] = record;
  return { ok: false, notify: true, dispatch: structuredClone(record) };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function requireCaliforniaScheduleExportToken(
  authorization: string | null,
  configuredHash = process.env.PORTAL_CALIFORNIA_EXPORT_TOKEN_SHA256,
) {
  if (!configuredHash || !/^[a-f0-9]{64}$/i.test(configuredHash))
    throw new Problem(
      503,
      "California schedule export access is not configured.",
    );
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(authorization || "");
  if (!match)
    throw new Problem(401, "California schedule export authorization failed.");
  const actual = digest(match[1]),
    expected = Buffer.from(configuredHash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
    throw new Problem(401, "California schedule export authorization failed.");
}
