import { createHash, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  draftExportKey,
  extractDraft,
  recordDraftExport,
  validateDraftExport,
  type DraftExport,
  type DraftGrid,
} from "./draft-schedule";
import { DRAFT_ID } from "./google-draft";
import { Problem, type State } from "./model";

const zone = "America/Chicago";

export type ReportingDirectorySource = {
  source: string;
  observedAt: string;
  acceptedAt: string;
  rowCount: number;
  storeCount: number;
};

export function reportingDirectorySource(
  state: State,
): ReportingDirectorySource {
  const snapshot = state.sync.snapshot;
  if (!snapshot || !state.sync.lastSuccess)
    throw new Problem(
      409,
      "An accepted employee-directory source snapshot is required for reporting.",
    );
  return {
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    acceptedAt: state.sync.lastSuccess,
    rowCount: snapshot.rowCount,
    storeCount: snapshot.stores.length,
  };
}

export const reportingDraftExportRequestSchema = z
  .object({
    weekStart: z.iso.date(),
    storeIds: z.array(z.string().trim().min(1).max(40)).min(1).max(32),
  })
  .strict()
  .refine((value) => new Set(value.storeIds).size === value.storeIds.length, {
    message: "Store IDs must be unique.",
    path: ["storeIds"],
  });

function tokenDigest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function requireReportingExportToken(
  authorization: string | null,
  configuredHash = process.env.PORTAL_REPORT_EXPORT_TOKEN_SHA256,
) {
  if (!configuredHash || !/^[a-f0-9]{64}$/i.test(configuredHash))
    throw new Problem(503, "Reporting export access is not configured.");
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(authorization || "");
  if (!match) throw new Problem(401, "Reporting export authorization failed.");
  const actual = tokenDigest(match[1]);
  const expected = Buffer.from(configuredHash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
    throw new Problem(401, "Reporting export authorization failed.");
}

function legacyOvernightRules(previous: DraftExport | undefined) {
  if (!previous) return [];
  if (Array.isArray(previous.overnight))
    return previous.overnight.map((entry) => ({ ...entry }));
  const week = DateTime.fromISO(previous.snapshot.weekStart, { zone });
  return previous.snapshot.shifts
    .filter((shift) => {
      const end = DateTime.fromISO(shift.end, { setZone: true }).setZone(zone);
      return end.toISODate() !== shift.businessDate;
    })
    .map((shift) => ({
      row: shift.source.row,
      day: Math.round(
        DateTime.fromISO(shift.businessDate, { zone }).diff(week, "days").days,
      ),
    }));
}

export type ReportingDraftExportResult =
  | {
      storeId: string;
      status: "ready";
      issues: [];
      export: DraftExport;
    }
  | {
      storeId: string;
      status: "blocked";
      issues: string[];
      export: null;
    };

/**
 * A reporting/snapshot read is intentionally different from the accepted
 * complete-store export. It exposes valid shifts and the exact exceptions so
 * a Sunday publisher can omit only the affected employee, while report
 * generators may still enforce an all-or-nothing store policy.
 */
export function finalizeTexasReportingExports(
  grid: DraftGrid,
  state: State,
  request: z.infer<typeof reportingDraftExportRequestSchema>,
  workbookId = DRAFT_ID,
) {
  const parsed = reportingDraftExportRequestSchema.parse(request);
  const weeks = parsed.storeIds.map(
    (storeId) =>
      extractDraft(grid, storeId, 1, [], [], workbookId).input.weekStart,
  );
  if (weeks.some((weekStart) => weekStart !== parsed.weekStart))
    throw new Problem(
      409,
      `Schedule P1 does not match requested week ${parsed.weekStart}.`,
    );
  return {
    version: 1 as const,
    state: "texas" as const,
    weekStart: parsed.weekStart,
    workbookId,
    generatedAt: new Date().toISOString(),
    results: parsed.storeIds.map((storeId) => {
      const key = draftExportKey(storeId, parsed.weekStart, false, workbookId);
      const previous = state.sync.draftExports?.[key];
      const exportResult = validateDraftExport(
        grid,
        state.employees,
        storeId,
        previous,
        [],
        legacyOvernightRules(previous),
        workbookId,
      );
      const issues = exportResult.snapshot.exceptions.map(
        (issue) => `Row ${issue.row}: ${issue.reason}`,
      );
      const invalidIdentity = exportResult.snapshot.shifts.filter(
        (shift) => shift.posIdentityPending || !shift.posEmployeeId,
      );
      const pending = invalidIdentity.length;
      if (pending)
        issues.push(
          `${pending} shift${pending === 1 ? " has" : "s have"} POS verification pending.`,
        );
      const validShifts = exportResult.snapshot.shifts.filter(
        (shift) => !shift.posIdentityPending && Boolean(shift.posEmployeeId),
      );
      const finalized = {
        ...exportResult,
        snapshot: {
          ...exportResult.snapshot,
          shifts: validShifts,
          valid: validShifts.length,
          exceptionCount: exportResult.snapshot.exceptionCount + pending,
          ready: exportResult.snapshot.ready && pending === 0,
        },
      };
      if (!finalized.snapshot.valid)
        issues.push("No validated shifts were found.");
      return {
        storeId,
        status:
          finalized.snapshot.ready &&
          finalized.scope === "complete-store" &&
          !pending &&
          validShifts.length > 0
            ? ("ready" as const)
            : ("blocked" as const),
        issues,
        export: finalized,
      };
    }),
  };
}

export function validateReportingDraftExports(
  grid: DraftGrid,
  state: State,
  request: z.infer<typeof reportingDraftExportRequestSchema>,
  workbookId = DRAFT_ID,
) {
  const parsed = reportingDraftExportRequestSchema.parse(request);
  const weeks = parsed.storeIds.map(
    (storeId) =>
      extractDraft(grid, storeId, 1, [], [], workbookId).input.weekStart,
  );
  if (weeks.some((weekStart) => weekStart !== parsed.weekStart))
    throw new Problem(
      409,
      `Schedule P1 does not match requested week ${parsed.weekStart}.`,
    );

  const results: ReportingDraftExportResult[] = parsed.storeIds.map(
    (storeId) => {
      const key = draftExportKey(storeId, parsed.weekStart, false, workbookId);
      const previous = state.sync.draftExports?.[key];
      const result = validateDraftExport(
        grid,
        state.employees,
        storeId,
        previous,
        [],
        legacyOvernightRules(previous),
        workbookId,
      );
      const issues = result.snapshot.exceptions.map(
        (issue) => `Row ${issue.row}: ${issue.reason}`,
      );
      if (!result.snapshot.valid)
        issues.push("No validated shifts were found.");
      const pending = result.snapshot.shifts.filter(
        (shift) => shift.posIdentityPending || !shift.posEmployeeId,
      ).length;
      if (pending)
        issues.push(
          `${pending} shift${pending === 1 ? " has" : "s have"} POS verification pending.`,
        );
      if (
        !result.snapshot.ready ||
        result.scope !== "complete-store" ||
        result.omitted.length ||
        issues.length
      )
        return { storeId, status: "blocked", issues, export: null };

      recordDraftExport(state, result, {
        id: "reporting-service",
        role: "admin",
      });
      return { storeId, status: "ready", issues: [], export: result };
    },
  );

  return {
    version: 1,
    workbookId,
    weekStart: parsed.weekStart,
    generatedAt: new Date().toISOString(),
    results,
  };
}
