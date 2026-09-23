import { MongoClient, type Document } from "mongodb";
import { z } from "zod";
import { Problem, type ScheduleTargetState } from "./model";

const scheduleSchema = z
  .object({
    scheduleId: z.string().trim().min(1).max(120),
    sheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    sheetName: z.string().trim().min(1).max(200),
    sheetUrl: z
      .string()
      .url()
      .startsWith("https://docs.google.com/spreadsheets/"),
    weekStart: z.iso.date(),
    weekEnd: z.iso.date(),
    addedAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime().optional(),
  })
  .strict();

const stateSchema = z
  .object({
    state: z.enum(["texas", "california"]),
    schedules: z.array(z.unknown()),
  })
  .passthrough();

export type ScheduleCatalogEntry = z.infer<typeof scheduleSchema> & {
  state: ScheduleTargetState;
  targetKey: string;
};

let connection: Promise<MongoClient> | undefined;

function client() {
  const uri = process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI;
  if (!uri)
    throw new Problem(
      503,
      "The schedule catalog connection is not configured.",
    );
  connection ??= new MongoClient(uri, {
    readPreference: "secondaryPreferred",
    retryWrites: false,
    readConcern: { level: "majority" },
    serverSelectionTimeoutMS: 8_000,
    maxPoolSize: 3,
  }).connect();
  return connection;
}

export function parseScheduleCatalogDocument(
  raw: unknown,
  state: ScheduleTargetState,
): ScheduleCatalogEntry[] {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== state)
    throw new Problem(502, `The ${state} schedule catalog is invalid.`);
  const seenSchedule = new Set<string>(),
    seenSheet = new Set<string>();
  const entries = parsed.data.schedules.flatMap((candidate) => {
    const parsedEntry = scheduleSchema.safeParse(candidate);
    if (!parsedEntry.success) return [];
    const entry = parsedEntry.data;
    const url = new URL(entry.sheetUrl);
    if (url.pathname.split("/")[3] !== entry.sheetId) return [];
    if (seenSchedule.has(entry.scheduleId) || seenSheet.has(entry.sheetId))
      throw new Problem(
        502,
        `The ${state} schedule catalog contains duplicates.`,
      );
    seenSchedule.add(entry.scheduleId);
    seenSheet.add(entry.sheetId);
    return [{
      ...entry,
      state,
      targetKey: `schedule:${entry.scheduleId}`,
    }];
  });
  if (!entries.length)
    throw new Problem(502, `The ${state} schedule catalog has no valid schedules.`);
  return entries
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    .slice(0, 8);
}

export async function readScheduleCatalog(
  state: ScheduleTargetState,
): Promise<ScheduleCatalogEntry[]> {
  const mongo = await client();
  const raw = await mongo
    .db("ScheduleDB")
    .collection<Document>("google_sheets")
    .findOne(
      { state },
      {
        projection: {
          _id: 0,
          state: 1,
          schedules: 1,
        },
      },
    );
  if (!raw) throw new Problem(502, `The ${state} schedule catalog is missing.`);
  return parseScheduleCatalogDocument(raw, state);
}

export async function readTargetCatalog() {
  const [texas, california] = await Promise.all([
    readScheduleCatalog("texas"),
    readScheduleCatalog("california"),
  ]);
  return { texas, california };
}

/**
 * Read-only receipt evidence for a published schedule. The receiver owns this
 * collection; this function deliberately aggregates only the legacy schedule
 * envelope and never creates, updates, or deletes a ScheduleDB record.
 */
export async function readPublishedScheduleCounts(
  state: "California" | "Texas",
  brand: string,
  weekStart: string,
) {
  const mongo = await client();
  const documents = await mongo
    .db("ScheduleDB")
    .collection<Document>("employee_shifts")
    .find(
      {
        week_start: weekStart,
        state: { $in: [state, state.toLowerCase(), state.slice(0, 2).toUpperCase()] },
        brand: { $in: [brand, brand.toLowerCase()] },
      },
      { projection: { _id: 0, schedule: 1 } },
    )
    .toArray();
  const countsByStore: Record<string, number> = {};
  for (const document of documents) {
    if (!Array.isArray(document.schedule)) continue;
    for (const raw of document.schedule) {
      if (!raw || typeof raw !== "object") continue;
      const shift = raw as Record<string, unknown>;
      const storeId = String(
        shift["Store ID"] ?? shift.store_id ?? shift.location_id ?? "",
      ).trim();
      if (!storeId) continue;
      countsByStore[storeId] = (countsByStore[storeId] || 0) + 1;
    }
  }
  return {
    sourceDocuments: documents.length,
    shiftCount: Object.values(countsByStore).reduce((sum, count) => sum + count, 0),
    countsByStore,
  };
}
