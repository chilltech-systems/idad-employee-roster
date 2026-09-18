import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CALIFORNIA_DRAFT_ID } from "./google-california-draft";
import { DRAFT_ID } from "./google-draft";
import { inspectGoogleSchedule } from "./google-schedule-access";
import {
  Problem,
  requireAdmin,
  type Account,
  type ScheduleTarget,
  type ScheduleTargetState,
  type State,
} from "./model";
import {
  readScheduleCatalog,
  type ScheduleCatalogEntry,
} from "./schedule-catalog";

export const TEST_TARGET_KEY = "test-current-draft";

export const scheduleTargetSelectionSchema = z
  .object({
    state: z.enum(["texas", "california"]),
    targetKey: z.string().trim().min(1).max(160),
  })
  .strict();

export type ScheduleTargetOption = {
  state: ScheduleTargetState;
  targetKey: string;
  kind: "test" | "schedule";
  scheduleId: string;
  spreadsheetId: string;
  sheetName: string;
  sheetUrl: string;
  weekStart?: string;
  weekEnd?: string;
};

function testOption(state: ScheduleTargetState): ScheduleTargetOption {
  const texas = state === "texas",
    spreadsheetId = texas ? DRAFT_ID : CALIFORNIA_DRAFT_ID;
  return {
    state,
    targetKey: TEST_TARGET_KEY,
    kind: "test",
    scheduleId: TEST_TARGET_KEY,
    spreadsheetId,
    sheetName: "Test Schedule — Current Directory Draft",
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=1883086419`,
  };
}

function catalogOption(entry: ScheduleCatalogEntry): ScheduleTargetOption {
  return {
    state: entry.state,
    targetKey: entry.targetKey,
    kind: "schedule",
    scheduleId: entry.scheduleId,
    spreadsheetId: entry.sheetId,
    sheetName: entry.sheetName,
    sheetUrl: entry.sheetUrl,
    weekStart: entry.weekStart,
    weekEnd: entry.weekEnd,
  };
}

export function legacyScheduleTarget(
  state: ScheduleTargetState,
): ScheduleTarget {
  const option = testOption(state);
  return {
    ...option,
    selectedAt: "",
    selectedBy: "system-default",
    readiness: "test-draft",
  };
}

export function activeScheduleTarget(
  state: State,
  targetState: ScheduleTargetState,
) {
  return (
    state.sync.scheduleTargets?.[targetState] ||
    legacyScheduleTarget(targetState)
  );
}

export async function scheduleTargetOptions(
  state: ScheduleTargetState,
  readCatalog: typeof readScheduleCatalog = readScheduleCatalog,
) {
  const catalog = process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI
    ? await readCatalog(state)
    : [];
  return [testOption(state), ...catalog.map(catalogOption)];
}

export async function resolveScheduleTarget(
  raw: unknown,
  readCatalog: typeof readScheduleCatalog = readScheduleCatalog,
  inspect: typeof inspectGoogleSchedule = inspectGoogleSchedule,
) {
  const selection = scheduleTargetSelectionSchema.parse(raw);
  let option: ScheduleTargetOption;
  if (selection.targetKey === TEST_TARGET_KEY) {
    option = testOption(selection.state);
  } else {
    if (!selection.targetKey.startsWith("schedule:"))
      throw new Problem(400, "Unknown schedule target.");
    const entries = await readCatalog(selection.state),
      entry = entries.find(
        (candidate) => candidate.targetKey === selection.targetKey,
      );
    if (!entry)
      throw new Problem(404, "Schedule target is no longer available.");
    option = catalogOption(entry);
  }
  const inspected = await inspect(
    option.state,
    option.spreadsheetId,
    option.kind,
  );
  return { option, readiness: inspected.readiness };
}

export function saveScheduleTarget(
  state: State,
  account: Account,
  resolved: Awaited<ReturnType<typeof resolveScheduleTarget>>,
  now = () => new Date().toISOString(),
) {
  requireAdmin(account);
  if (
    (state.sync.leases?.[`draft:${resolved.option.state}`]?.expiresAt || 0) >
    Date.now()
  )
    throw new Problem(
      409,
      "A schedule sync is running. Retry the target change shortly.",
    );
  const previous = activeScheduleTarget(state, resolved.option.state),
    selectedAt = now(),
    target: ScheduleTarget = {
      ...resolved.option,
      selectedAt,
      selectedBy: account.id,
      readiness: resolved.readiness,
      ...(previous.targetKey === resolved.option.targetKey && previous.lastSync
        ? { lastSync: previous.lastSync }
        : {}),
    };
  state.sync.scheduleTargets ??= {};
  state.sync.scheduleTargets[target.state] = target;
  const failedStates = (["texas", "california"] as const).filter(
    (targetState) =>
      state.sync.scheduleTargets?.[targetState]?.lastSync?.status === "failed",
  );
  if (state.sync.automation)
    state.sync.automation.error = failedStates.length
      ? `${failedStates
          .map(
            (targetState) =>
              `${targetState[0].toUpperCase()}${targetState.slice(1)}`,
          )
          .join(
            " and ",
          )} schedule sync failed; the previous verified state was retained.`
      : undefined;
  state.audit.push({
    id: randomUUID(),
    at: selectedAt,
    actor: account.id,
    action: "schedule.target-selected",
    reason: `${target.state}: ${previous.sheetName} -> ${target.sheetName}`,
  });
  return target;
}

export async function targetOverview(
  state: State,
  account: Account,
  readCatalog: typeof readScheduleCatalog = readScheduleCatalog,
) {
  requireAdmin(account);
  const [texas, california] = await Promise.all([
    scheduleTargetOptions("texas", readCatalog),
    scheduleTargetOptions("california", readCatalog),
  ]);
  return {
    configured: !!process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI,
    states: {
      texas: {
        active: activeScheduleTarget(state, "texas"),
        options: texas,
      },
      california: {
        active: activeScheduleTarget(state, "california"),
        options: california,
      },
    },
  };
}
