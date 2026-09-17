import { withSyncLease } from "./sync-lease";
import { draftClient } from "./google-draft";
import {
  stableDraft,
  planDraftSync,
  draftFingerprint,
  rosterFromGrid,
} from "./draft-schedule";
import { repository } from "./repository";
import { Problem } from "./model";
export async function syncDraftNow() {
  return withSyncLease("draft", async (assertHeld) => {
    const client = await draftClient(),
      grid = await stableDraft(client);
    const employees = await repository().transact((s) =>
      structuredClone(s.employees),
    );
    const plan = planDraftSync(grid, employees);
    await assertHeld();
    if (plan.requests.length) await client.write(plan.requests);
    const after = await stableDraft(client);
    if (JSON.stringify(rosterFromGrid(after)) !== JSON.stringify(plan.roster))
      throw new Problem(409, "Draft roster readback differed; retry sync.");
    // Names/times are never mutation targets, so simultaneous manager edits remain intact.
    await repository().transact((s) => {
      s.sync.automation = {
        ...s.sync.automation,
        lastDraft: new Date().toISOString(),
        error: undefined,
      };
    });
    return {
      ok: true,
      active: plan.active,
      aliases: plan.roster.length,
      fingerprint: draftFingerprint(after),
    };
  });
}
