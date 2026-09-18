import { mode, stores } from "./config";
import {
  mergeCurrentDayRoster,
  readRosterActivity,
} from "./current-day-roster";
import { readGoogleRoster } from "./google-roster";
import { Problem } from "./model";
// The adapter endpoint must return a complete, validated roster envelope; its own
// credentials should grant read access only to the source workbook (Google ACLs
// cannot be scoped to an individual tab). The adapter reads only the import tab.
export async function fetchRoster(
  options: { includeCurrentDay?: boolean } = { includeCurrentDay: true },
) {
  if (mode() === "demo")
    return {
      source: "fictional-roster",
      complete: true,
      observedAt: new Date().toISOString(),
      stores: ["TX-DEMO-1", "TX-DEMO-2"],
      rowCount: 5,
      rows: [
        {
          storeId: "TX-DEMO-1",
          posSource: "Qu",
          posEmployeeId: "00101",
          posName: "Maya Bennett",
        },
        {
          storeId: "TX-DEMO-1",
          posSource: "Qu",
          posEmployeeId: "00102",
          posName: "Jordan Reed",
        },
        {
          storeId: "TX-DEMO-1",
          posSource: "Qu",
          posEmployeeId: "00103",
          posName: "Alex Rivera",
        },
        {
          storeId: "TX-DEMO-1",
          posSource: "Qu",
          posEmployeeId: "00104",
          posName: "Sam Chen",
        },
        {
          storeId: "TX-DEMO-2",
          posSource: "Qu",
          posEmployeeId: "00901",
          posName: "Casey Lane",
        },
      ],
    };
  if (process.env.PORTAL_ROSTER_SOURCE === "google-sheets") {
    const enabled = stores();
    const baseline = await readGoogleRoster(enabled);
    if (!options.includeCurrentDay) return baseline;
    const current = await readRosterActivity(enabled);
    return mergeCurrentDayRoster(baseline, current);
  }
  const url = process.env.PORTAL_ROSTER_URL;
  if (!url || !process.env.PORTAL_ROSTER_TOKEN)
    throw new Problem(503, "Read-only roster connection is not configured.");
  if (new URL(url).protocol !== "https:")
    throw new Problem(503, "Roster connection requires HTTPS.");
  const result = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.PORTAL_ROSTER_TOKEN}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!result.ok)
    throw new Problem(
      502,
      "Roster source could not be read. Last successful roster is retained.",
    );
  const limit = 2_000_000;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.body!) {
    bytes += chunk.length;
    if (bytes > limit)
      throw new Problem(502, "Roster exceeds the allowed size.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
