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
    schedules: z.array(scheduleSchema),
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
  const entries = parsed.data.schedules.map((entry) => {
    if (seenSchedule.has(entry.scheduleId) || seenSheet.has(entry.sheetId))
      throw new Problem(
        502,
        `The ${state} schedule catalog contains duplicates.`,
      );
    const url = new URL(entry.sheetUrl);
    if (url.pathname.split("/")[3] !== entry.sheetId)
      throw new Problem(
        502,
        `The ${state} schedule catalog contains mismatched workbook identities.`,
      );
    seenSchedule.add(entry.scheduleId);
    seenSheet.add(entry.sheetId);
    return {
      ...entry,
      state,
      targetKey: `schedule:${entry.scheduleId}`,
    };
  });
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
