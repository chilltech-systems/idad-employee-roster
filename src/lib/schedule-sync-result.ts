import type { ScheduleNameMatch, ScheduleNameMiss } from "./draft-schedule";
import type { ScheduleTargetState } from "./model";

export type ScheduleSyncStateResult = {
  state: ScheduleTargetState;
  reconciliation?: {
    reconciled: ScheduleNameMatch[];
    unmatched: ScheduleNameMiss[];
  };
};

export type ScheduleSyncResponse = {
  ok: true;
  result?: ScheduleSyncStateResult;
  results?: ScheduleSyncStateResult[];
};

export function scheduleSyncNotice(response: ScheduleSyncResponse) {
  const results = response.result ? [response.result] : response.results || [],
    texas = results.find((result) => result.state === "texas"),
    reconciliation = texas?.reconciliation;
  if (!reconciliation)
    return results.length === 1
      ? `${results[0].state === "california" ? "California" : "Texas"} schedule dropdowns synced successfully.`
      : "Schedule dropdowns synced successfully.";

  const matched = reconciliation.reconciled.length,
    misses = reconciliation.unmatched;
  if (!misses.length)
    return `Texas schedule dropdowns synced successfully. Reconciled ${matched} existing name${matched === 1 ? "" : "s"}; every populated name cell is matched.`;
  const details = misses
    .map((miss) => {
      const reason =
        miss.reason === "ambiguous"
          ? `ambiguous${miss.candidates.length ? `: ${miss.candidates.join(" or ")}` : ""}`
          : "no directory match";
      return `${miss.cell} (${miss.storeId}, “${miss.value}” — ${reason})`;
    })
    .join("; ");
  return `Texas schedule dropdowns synced. Reconciled ${matched} existing name${matched === 1 ? "" : "s"}. ${misses.length} cell${misses.length === 1 ? "" : "s"} still need review: ${details}.`;
}
