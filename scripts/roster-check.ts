import { readFile } from "node:fs/promises";
import { z } from "zod";
import { storeSchema } from "../src/lib/model";
import { readGoogleRoster } from "../src/lib/google-roster";

// Reads Google only. Never imports into MongoDB, creates accounts, or logs names/IDs.
const enabled = z
  .array(storeSchema)
  .parse(
    JSON.parse(
      await readFile(
        new URL("../docs/texas-stores.json", import.meta.url),
        "utf8",
      ),
    ),
  );
try {
  const snapshot = await readGoogleRoster(enabled);
  console.log(
    JSON.stringify(
      {
        source: snapshot.source,
        observedAt: snapshot.observedAt,
        rowCount: snapshot.rowCount,
        stores: enabled.map((s) => ({
          id: s.id,
          count: snapshot.rows.filter((r) => r.storeId === s.id).length,
        })),
        databaseWrites: 0,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Roster check failed.");
  process.exitCode = 1;
}
