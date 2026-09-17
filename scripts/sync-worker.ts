import { fetchRoster } from "../src/lib/roster-source";
import { repository } from "../src/lib/repository";
import { refresh } from "../src/lib/service";
import { syncDraftNow } from "../src/lib/draft-operations";
if (
  process.env.PORTAL_AUTOMATION_ENABLED !== "yes" ||
  process.env.PORTAL_MODE !== "mongo-test" ||
  process.env.VERCEL
)
  throw new Error("Only explicitly enabled local test automation is allowed.");
let stopping = false,
  lastRoster = 0;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
async function cycle() {
  try {
    if (Date.now() - lastRoster >= 15 * 60 * 1000) {
      const snapshot = await fetchRoster();
      const result = await repository().transact((s) =>
        refresh(s, { id: "local-roster-worker", role: "admin" }, snapshot),
      );
      if (result.error) throw new Error(result.error);
      lastRoster = Date.now();
      await repository().transact((s) => {
        s.sync.automation = {
          ...s.sync.automation,
          heartbeat: new Date().toISOString(),
          lastRoster: new Date().toISOString(),
        };
      });
    }
    const draft = await syncDraftNow();
    await repository().transact((s) => {
      s.sync.automation = {
        ...s.sync.automation,
        heartbeat: new Date().toISOString(),
        error: undefined,
      };
    });
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        roster: "ok",
        draft: "ok",
        active: draft.active,
      }),
    );
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    // Errors exposed by the integration are sanitized; never log tokens, employee rows, or credential content.
    await repository().transact((s) => {
      s.sync.automation = {
        ...s.sync.automation,
        heartbeat: new Date().toISOString(),
        error: message,
      };
    });
    console.error(
      JSON.stringify({ at: new Date().toISOString(), error: message }),
    );
    return false;
  }
}
const ok = await cycle();
if (process.argv.includes("--once")) process.exit(ok ? 0 : 1);
while (!stopping) {
  await new Promise((r) => setTimeout(r, 60000));
  if (!stopping) await cycle();
}
process.exit(0);
