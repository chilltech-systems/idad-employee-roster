import { withSyncLease } from "./sync-lease";
import { draftClient } from "./google-draft";
import {
  stableDraft,
  planDraftSync,
  draftFingerprint,
  rosterFromGrid,
  initialTexasRoster,
} from "./draft-schedule";
import { repository } from "./repository";
import { Problem, type ScheduleTargetState } from "./model";
import { californiaDraftClient } from "./google-california-draft";
import {
  assertCaliforniaDraftReadback,
  californiaDraftFingerprint,
  planCaliforniaDraftPreparation,
  planCaliforniaDraftSync,
  stableCaliforniaDraft,
} from "./california-draft-schedule";
import { activeScheduleTarget } from "./schedule-targets";

async function selectedTarget(state: ScheduleTargetState) {
  return repository().transact((value) => ({
    target: structuredClone(activeScheduleTarget(value, state)),
    employees: structuredClone(value.employees),
  }));
}
type SelectedTarget = Awaited<ReturnType<typeof selectedTarget>>;

async function assertTargetUnchanged(
  state: ScheduleTargetState,
  targetKey: string,
  spreadsheetId: string,
) {
  await repository().transact((value) => {
    const current = activeScheduleTarget(value, state);
    if (
      current.targetKey !== targetKey ||
      current.spreadsheetId !== spreadsheetId
    )
      throw new Problem(409, "Schedule target changed during sync; retry.");
  });
}

async function recordResult(
  state: ScheduleTargetState,
  target: Awaited<ReturnType<typeof selectedTarget>>["target"],
  status: "ready" | "failed",
  message?: string,
) {
  const at = new Date().toISOString();
  await repository().transact((value) => {
    const current = activeScheduleTarget(value, state);
    if (
      current.targetKey !== target.targetKey ||
      current.spreadsheetId !== target.spreadsheetId
    )
      return;
    value.sync.scheduleTargets ??= {};
    value.sync.scheduleTargets[state] = {
      ...current,
      readiness: status === "ready" ? "ready" : "sync-failed",
      lastSync: { at, status, ...(message ? { message } : {}) },
    };
    const failedStates = (["texas", "california"] as const).filter(
      (targetState) =>
        value.sync.scheduleTargets?.[targetState]?.lastSync?.status ===
        "failed",
    );
    value.sync.automation = {
      ...value.sync.automation,
      ...(status === "ready" ? { lastDraft: at } : {}),
      error: failedStates.length
        ? `${failedStates
            .map(
              (targetState) =>
                `${targetState[0].toUpperCase()}${targetState.slice(1)}`,
            )
            .join(
              " and ",
            )} schedule sync failed; the previous verified state was retained.`
        : undefined,
    };
  });
}

async function syncTexas(
  assertHeld: () => Promise<void>,
  { target, employees }: SelectedTarget,
) {
  const client = await draftClient(fetch, target.spreadsheetId);
  await assertHeld();
  await assertTargetUnchanged("texas", target.targetKey, target.spreadsheetId);
  const prepared = await client.prepare(initialTexasRoster(employees)),
    grid = await stableDraft(client, target.spreadsheetId),
    plan = planDraftSync(grid, employees, target.spreadsheetId);
  await assertHeld();
  await assertTargetUnchanged("texas", target.targetKey, target.spreadsheetId);
  if (plan.requests.length) await client.write(plan.requests);
  const after = await stableDraft(client, target.spreadsheetId);
  if (
    JSON.stringify(rosterFromGrid(after, target.spreadsheetId)) !==
    JSON.stringify(plan.roster)
  )
    throw new Problem(409, "Texas roster readback differed; retry sync.");
  await recordResult("texas", target, "ready");
  return {
    state: "texas" as const,
    targetKey: target.targetKey,
    prepared,
    active: plan.active,
    aliases: plan.roster.length,
    fingerprint: draftFingerprint(after, target.spreadsheetId),
  };
}

async function syncCalifornia(
  assertHeld: () => Promise<void>,
  { target, employees }: SelectedTarget,
) {
  const client = await californiaDraftClient(fetch, target.spreadsheetId),
    first = await client.read(),
    second = await client.read();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Problem(
      409,
      "California schedule changed during preparation; retry after editing.",
    );
  const preparation = planCaliforniaDraftPreparation(
    second,
    employees,
    target.spreadsheetId,
  );
  if (preparation.requests.length) {
    await assertHeld();
    await assertTargetUnchanged(
      "california",
      target.targetKey,
      target.spreadsheetId,
    );
    await client.write(preparation.requests);
  }
  const grid = await stableCaliforniaDraft(client, target.spreadsheetId),
    plan = planCaliforniaDraftSync(grid, employees, target.spreadsheetId);
  await assertHeld();
  await assertTargetUnchanged(
    "california",
    target.targetKey,
    target.spreadsheetId,
  );
  if (plan.requests.length) await client.write(plan.requests);
  const after = await stableCaliforniaDraft(client, target.spreadsheetId);
  assertCaliforniaDraftReadback(after, plan.roster, target.spreadsheetId);
  await recordResult("california", target, "ready");
  return {
    state: "california" as const,
    targetKey: target.targetKey,
    prepared: preparation.prepared,
    active: plan.active,
    aliases: plan.roster.length,
    fingerprint: californiaDraftFingerprint(after, target.spreadsheetId),
  };
}

async function syncOne(state: ScheduleTargetState) {
  const selection = await selectedTarget(state);
  try {
    if (state === "texas")
      return await withSyncLease("draft:texas", (assertHeld) =>
        syncTexas(assertHeld, selection),
      );
    return await withSyncLease("draft:california", (assertHeld) =>
      syncCalifornia(assertHeld, selection),
    );
  } catch (error) {
    if (
      !(error instanceof Problem) ||
      error.status !== 409 ||
      !error.message.includes("already running")
    )
      await recordResult(
        state,
        selection.target,
        "failed",
        (error as Error).message,
      );
    throw error;
  }
}

export async function syncDraftNow(state?: ScheduleTargetState) {
  if (state) return { ok: true, result: await syncOne(state) };
  const results: unknown[] = [],
    failures: string[] = [];
  let active = 0;
  for (const targetState of ["texas", "california"] as const) {
    try {
      const result = await syncOne(targetState);
      results.push(result);
      active += result.active;
    } catch (error) {
      failures.push(`${targetState}: ${(error as Error).message}`);
    }
  }
  if (failures.length)
    throw new Problem(
      502,
      `Schedule sync completed with ${failures.length} state failure${failures.length === 1 ? "" : "s"}: ${failures.join(" ")}`,
    );
  return {
    ok: true,
    results,
    active,
  };
}
