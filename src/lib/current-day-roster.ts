import { z } from "zod";
import { Problem, identityKey, type Roster, type Store } from "./model";
import { storeCodeKey, storeCodeMap } from "./store-codes";

export const quEmployeeSalesBaseUrl =
  "https://idad-resource.vercel.app/api/v1/qu/sales/employee-sales/all";
export const toastEmployeeSalesBaseUrl =
  "https://idad-resource.vercel.app/api/v1/toast/sales/employee-sales/all";
export const quLocationsUrl =
  "https://idad-resource.vercel.app/api/v1/locations";
export const quClockedInBaseUrl =
  "https://idad-resource.vercel.app/api/v1/qu/labor/clocked-in";
export const toastLaborAllBaseUrl =
  "https://idad-resource.vercel.app/api/v1/toast/labor/all";
export const dailyReportBaseUrl =
  "https://idad-resource.vercel.app/api/v2/reports/daily";

const stateTimeZones: Record<string, string> = {
  Arizona: "America/Phoenix",
  California: "America/Los_Angeles",
  Colorado: "America/Denver",
  Hawaii: "Pacific/Honolulu",
  Texas: "America/Chicago",
};

const employeeSchema = z
  .object({
    employee_id: z.union([z.string(), z.number(), z.null()]).optional(),
    name: z.string().optional(),
  })
  .passthrough();
const storeResultSchema = z
  .object({ store_code: z.string(), employeeSales: z.array(employeeSchema) })
  .passthrough();
const locationSchema = z
  .object({
    store_code: z.string(),
    api_store_id: z.union([z.string(), z.number()]),
  })
  .passthrough();
const quClockedInSchema = z
  .object({
    data: z.array(
      z
        .object({
          employee_id: z.union([z.string(), z.number()]),
          employee_details: z
            .object({
              first_name: z.string().optional(),
              last_name: z.string().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const toastLaborStoreSchema = z
  .object({
    store_code: z.string(),
    labor: z.array(
      z
        .object({
          employee_details: z
            .object({
              guid: z.union([z.string(), z.number()]),
              firstName: z.string().optional(),
              lastName: z.string().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const dailyEmployeeSchema = z
  .object({
    employee_id: z.union([z.string(), z.number(), z.null()]).optional(),
    employee_name: z.string().optional(),
    clock_in: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();
const dailyStoreSchema = z
  .object({
    store_id: z.string(),
    pos_system: z.string(),
    labor_summary: z
      .object({ employees: z.array(dailyEmployeeSchema) })
      .passthrough(),
  })
  .passthrough();
const dailyReportSchema = z
  .object({ business_date: z.string(), stores: z.array(dailyStoreSchema) })
  .passthrough();

function localDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
  };
}

function dateFormats(date: Date) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return { iso: `${year}${month}${day}`, api: `${month}${day}${year}` };
}

export function gapBusinessDates(
  now = new Date(),
  timeZone = "America/Chicago",
) {
  const current = localDate(now, timeZone);
  const today = new Date(
    Date.UTC(current.year, current.month - 1, current.day),
  );
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - daysSinceMonday);
  const dates: Array<{ iso: string; api: string }> = [];
  for (
    const cursor = new Date(monday);
    cursor <= today;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  )
    dates.push(dateFormats(cursor));
  return dates;
}

export function centralBusinessDate(now = new Date()) {
  return gapBusinessDates(now, "America/Chicago").at(-1)!.api;
}

function timeZoneFor(store: Store) {
  return stateTimeZones[store.state] || "America/Chicago";
}
function sourceMatches(store: Store, source: string) {
  return (
    store.posSource.toLocaleLowerCase("en-US") ===
    source.toLocaleLowerCase("en-US")
  );
}

export function parseCurrentDayRoster(payload: unknown, enabled: Store[]) {
  const results = z.array(storeResultSchema).parse(payload);
  const stores = storeCodeMap(enabled);
  const rows: Roster["rows"] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const store = stores.get(storeCodeKey(result.store_code));
    if (!store) continue;
    for (const employee of result.employeeSales) {
      const posEmployeeId = String(employee.employee_id ?? "").trim();
      const posName = employee.name?.trim().replace(/\s+/g, " ") ?? "";
      if (!posEmployeeId || !posName) continue;
      const row = {
        storeId: store.id,
        posSource: store.posSource,
        posEmployeeId,
        posName,
      };
      const key = identityKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

async function boundedJson(response: Response, message: string) {
  if (!response.ok || !response.body) throw new Problem(502, message);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2_000_000)
      throw new Problem(
        502,
        "Roster activity response exceeds the allowed size.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Problem(502, "Roster activity returned invalid data.");
  }
}

async function readCompletedGapRoster(
  enabled: Store[],
  request: typeof fetch,
  now: Date,
) {
  const requiredByDate = new Map<string, Set<string>>();
  for (const store of enabled) {
    const dates = gapBusinessDates(now, timeZoneFor(store));
    for (const date of dates.slice(0, -1)) {
      const required = requiredByDate.get(date.iso) || new Set<string>();
      required.add(store.id);
      requiredByDate.set(date.iso, required);
    }
  }
  const storeMap = storeCodeMap(enabled);
  const rows = new Map<string, Roster["rows"][number]>();
  const completedDates = [...requiredByDate.keys()].sort();
  await Promise.all(
    completedDates.map(async (date) => {
      let payload: unknown;
      try {
        payload = await boundedJson(
          await request(`${dailyReportBaseUrl}?date=${date}`, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          }),
          `Clock-in coverage for ${date} could not be read. Last successful roster is retained.`,
        );
      } catch (error) {
        if (error instanceof Problem) throw error;
        throw new Problem(
          502,
          `Clock-in coverage for ${date} could not be read. Last successful roster is retained.`,
        );
      }
      const report = dailyReportSchema.parse(payload);
      if (report.business_date.replaceAll("-", "") !== date)
        throw new Problem(
          502,
          `Clock-in coverage returned the wrong date for ${date}.`,
        );
      const required = requiredByDate.get(date)!;
      const found = new Set<string>();
      for (const result of report.stores) {
        const store = storeMap.get(storeCodeKey(result.store_id));
        if (!store || !required.has(store.id)) continue;
        if (!sourceMatches(store, result.pos_system))
          throw new Problem(
            502,
            `Clock-in POS source changed for ${store.id}.`,
          );
        found.add(store.id);
        for (const employee of result.labor_summary.employees) {
          const posEmployeeId = String(employee.employee_id ?? "").trim();
          const posName =
            employee.employee_name?.trim().replace(/\s+/g, " ") ?? "";
          if (!employee.clock_in || !posEmployeeId || !posName) continue;
          const row = {
            storeId: store.id,
            posSource: store.posSource,
            posEmployeeId,
            posName,
          };
          rows.set(identityKey(row), row);
        }
      }
      const missing = [...required].filter((id) => !found.has(id));
      if (missing.length)
        throw new Problem(
          502,
          `Clock-in coverage for ${date} is missing enabled stores. Last successful roster is retained.`,
        );
    }),
  );
  return { dates: completedDates, rows: [...rows.values()] };
}

export async function readCurrentDayRoster(
  enabled: Store[],
  request: typeof fetch = fetch,
  now = new Date(),
) {
  const currentDates = new Map(
    enabled.map((store) => [
      store.id,
      gapBusinessDates(now, timeZoneFor(store)).at(-1)!.api,
    ]),
  );
  const unique = new Map<string, Roster["rows"][number]>();
  const salesSources = [
    { source: "Qu", url: quEmployeeSalesBaseUrl },
    { source: "Toast", url: toastEmployeeSalesBaseUrl },
  ];
  try {
    const salesReads: Array<Promise<Roster["rows"]>> = [];
    for (const source of salesSources) {
      const sourceStores = enabled.filter((store) =>
        sourceMatches(store, source.source),
      );
      const dates = [
        ...new Set(sourceStores.map((store) => currentDates.get(store.id)!)),
      ];
      for (const businessDate of dates) {
        const scoped = sourceStores.filter(
          (store) => currentDates.get(store.id) === businessDate,
        );
        salesReads.push(
          (async () =>
            parseCurrentDayRoster(
              await boundedJson(
                await request(`${source.url}?businessDate=${businessDate}`, {
                  method: "GET",
                  headers: { Accept: "application/json" },
                  cache: "no-store",
                  redirect: "error",
                  signal: AbortSignal.timeout(30000),
                }),
                "Current-day employee sales could not be read. Last successful roster is retained.",
              ),
              scoped,
            ))(),
        );
      }
    }
    // Sales is a secondary same-day angle, but once configured it remains part
    // of the accepted snapshot contract. A failed angle rejects the refresh.
    for (const rows of await Promise.all(salesReads))
      for (const row of rows) unique.set(identityKey(row), row);

    const toastStores = enabled.filter((store) =>
      sourceMatches(store, "Toast"),
    );
    const toastDates = [
      ...new Set(toastStores.map((store) => currentDates.get(store.id)!)),
    ];
    for (const businessDate of toastDates) {
      const scoped = toastStores.filter(
        (store) => currentDates.get(store.id) === businessDate,
      );
      const mapping = storeCodeMap(scoped);
      const payload = z.array(toastLaborStoreSchema).parse(
        await boundedJson(
          await request(
            `${toastLaborAllBaseUrl}?businessDate=${businessDate}`,
            {
              method: "GET",
              headers: { Accept: "application/json" },
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(15000),
            },
          ),
          "Current Toast clock-ins could not be read. Last successful roster is retained.",
        ),
      );
      const found = new Set<string>();
      for (const result of payload) {
        const store = mapping.get(storeCodeKey(result.store_code));
        if (!store) continue;
        found.add(store.id);
        for (const labor of result.labor) {
          const posEmployeeId = String(labor.employee_details.guid).trim();
          const posName = [
            labor.employee_details.firstName,
            labor.employee_details.lastName,
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " ");
          if (!posEmployeeId || !posName) continue;
          const row = {
            storeId: store.id,
            posSource: store.posSource,
            posEmployeeId,
            posName,
          };
          unique.set(identityKey(row), row);
        }
      }
      if (scoped.some((store) => !found.has(store.id)))
        throw new Problem(
          502,
          "Current Toast clock-ins are missing an enabled store.",
        );
    }

    const quStores = enabled.filter(
      (store) =>
        sourceMatches(store, "Qu") && !/^taco\s*john/i.test(store.brand),
    );
    if (quStores.length) {
      const locations = z.array(locationSchema).parse(
        await boundedJson(
          await request(quLocationsUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          }),
          "Current-day roster could not map enabled stores.",
        ),
      );
      const byStore = new Map(
        locations.map((location) => [
          storeCodeKey(location.store_code),
          String(location.api_store_id),
        ]),
      );
      // Keep Qu reads sequential; its upstream adapter can reject a burst.
      for (const store of quStores) {
        const apiStoreId = byStore.get(storeCodeKey(store.id));
        if (!apiStoreId)
          throw new Problem(
            502,
            "Current-day roster could not map an enabled store.",
          );
        const clock = quClockedInSchema.parse(
          await boundedJson(
            await request(
              `${quClockedInBaseUrl}?apiStoreId=${encodeURIComponent(apiStoreId)}`,
              {
                method: "GET",
                headers: { Accept: "application/json" },
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
              },
            ),
            "Current Qu clock-ins could not be read. Last successful roster is retained.",
          ),
        );
        for (const employee of clock.data) {
          const posEmployeeId = String(employee.employee_id).trim();
          const posName = [
            employee.employee_details.first_name,
            employee.employee_details.last_name,
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " ");
          if (!posEmployeeId || !posName) continue;
          const row = {
            storeId: store.id,
            posSource: store.posSource,
            posEmployeeId,
            posName,
          };
          unique.set(identityKey(row), row);
        }
      }
    }
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(502, "Current-day roster returned invalid data.");
  }
  const dates = [...new Set(currentDates.values())].sort();
  return { businessDate: dates.join(","), rows: [...unique.values()] };
}

export async function readRosterActivity(
  enabled: Store[],
  request: typeof fetch = fetch,
  now = new Date(),
) {
  const [completed, current] = await Promise.all([
    readCompletedGapRoster(enabled, request, now),
    readCurrentDayRoster(enabled, request, now),
  ]);
  const rows = new Map(completed.rows.map((row) => [identityKey(row), row]));
  for (const row of current.rows) rows.set(identityKey(row), row);
  const currentDates = current.businessDate
    .split(",")
    .filter(Boolean)
    .map((date) => `${date.slice(4, 8)}${date.slice(0, 4)}`);
  const dates = [...completed.dates, ...currentDates].filter(Boolean).sort();
  return {
    businessDate: current.businessDate,
    source: `clock-in-gap:${dates[0] || "none"}-${dates.at(-1) || "none"}+current-sales-clock-ins`,
    rows: [...rows.values()],
  };
}

export function mergeCurrentDayRoster(
  baseline: Roster,
  current: { businessDate: string; source?: string; rows: Roster["rows"] },
  observedAt = new Date().toISOString(),
) {
  const rows = new Map(baseline.rows.map((row) => [identityKey(row), row]));
  for (const row of current.rows) rows.set(identityKey(row), row);
  const merged = [...rows.values()].sort(
    (left, right) =>
      left.storeId.localeCompare(right.storeId) ||
      left.posName.localeCompare(right.posName) ||
      left.posEmployeeId.localeCompare(right.posEmployeeId),
  );
  return {
    ...baseline,
    source: `${baseline.source}+${current.source || `current-day:${current.businessDate}`}`,
    observedAt,
    rowCount: merged.length,
    rows: merged,
  } satisfies Roster;
}

export function retainPreviousRoster(current: Roster, previous?: Roster) {
  if (!previous) return current;
  const enabled = new Set(current.stores);
  const rows = new Map(
    previous.rows
      .filter((row) => enabled.has(row.storeId))
      .map((row) => [identityKey(row), row]),
  );
  for (const row of current.rows) rows.set(identityKey(row), row);
  const merged = [...rows.values()].sort(
    (left, right) =>
      left.storeId.localeCompare(right.storeId) ||
      left.posName.localeCompare(right.posName) ||
      left.posEmployeeId.localeCompare(right.posEmployeeId),
  );
  return { ...current, rowCount: merged.length, rows: merged } satisfies Roster;
}
