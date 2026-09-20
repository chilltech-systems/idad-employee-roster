import test from "node:test";
import assert from "node:assert/strict";
import { scheduleSyncNotice } from "../src/lib/schedule-sync-result";

test("sync notice reports every unmatched Texas cell and reconciliation count", () => {
  const notice = scheduleSyncNotice({
    ok: true,
    result: {
      state: "texas",
      reconciliation: {
        reconciled: [
          {
            cell: "N22",
            row: 22,
            storeId: "TX-149",
            from: "Jamie",
            to: "Jamie C.",
          },
        ],
        unmatched: [
          {
            cell: "N23",
            row: 23,
            storeId: "TX-149",
            value: "Unknown",
            reason: "no-match",
            candidates: [],
          },
          {
            cell: "N144",
            row: 144,
            storeId: "TX-144",
            value: "Ricardo",
            reason: "ambiguous",
            candidates: ["Ricardo C.", "Ricardo S."],
          },
        ],
      },
    },
  });
  assert.match(notice, /Reconciled 1 existing name/);
  assert.match(notice, /N23 \(TX-149, “Unknown” — no directory match\)/);
  assert.match(
    notice,
    /N144 \(TX-144, “Ricardo” — ambiguous: Ricardo C\. or Ricardo S\.\)/,
  );
});
