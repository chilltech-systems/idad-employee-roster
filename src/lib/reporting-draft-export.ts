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

export function validateReportingDraftExports(
  grid: DraftGrid,
  state: State,
  request: z.infer<typeof reportingDraftExportRequestSchema>,
) {
  const parsed = reportingDraftExportRequestSchema.parse(request);
  const weeks = parsed.storeIds.map(
    (storeId) => extractDraft(grid, storeId, 1).input.weekStart,
  );
  if (weeks.some((weekStart) => weekStart !== parsed.weekStart))
    throw new Problem(
      409,
      `Schedule P1 does not match requested week ${parsed.weekStart}.`,
    );

  const results: ReportingDraftExportResult[] = parsed.storeIds.map(
    (storeId) => {
      const key = draftExportKey(storeId, parsed.weekStart);
      const previous = state.sync.draftExports?.[key];
      const result = validateDraftExport(
        grid,
        state.employees,
        storeId,
        previous,
        [],
        legacyOvernightRules(previous),
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
    workbookId: DRAFT_ID,
    weekStart: parsed.weekStart,
    generatedAt: new Date().toISOString(),
    results,
  };
}
