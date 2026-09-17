import { z } from "zod";
import { Problem, identityKey, type Roster, type Store } from "./model";

export const quEmployeeSalesBaseUrl =
  "https://idad-resource.vercel.app/api/v1/qu/sales/employee-sales/all";
export const quLocationsUrl = "https://idad-resource.vercel.app/api/v1/locations";
export const quClockedInBaseUrl =
  "https://idad-resource.vercel.app/api/v1/qu/labor/clocked-in";

const employeeSchema = z
  .object({
    employee_id: z.union([z.string(), z.number(), z.null()]).optional(),
    name: z.string().optional(),
  })
  .passthrough();

const storeResultSchema = z
  .object({
    store_code: z.string(),
    employeeSales: z.array(employeeSchema),
  })
  .passthrough();

const locationSchema = z
  .object({
    store_code: z.string(),
    api_store_id: z.union([z.string(), z.number()]),
  })
  .passthrough();

const clockedInSchema = z
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

export function centralBusinessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("month")}${value("day")}${value("year")}`;
}

export function parseCurrentDayRoster(payload: unknown, enabled: Store[]) {
  const results = z.array(storeResultSchema).parse(payload);
  const stores = new Map(
    enabled.map((store) => [store.id.toLowerCase(), store]),
  );
  const rows: Roster["rows"] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const store = stores.get(result.store_code.trim().toLowerCase());
    if (!store || store.posSource !== "Qu") continue;
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

async function boundedJson(response: Response) {
  if (!response.ok || !response.body)
    throw new Problem(
      502,
      "Current-day roster could not be read. Last successful roster is retained.",
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2_000_000)
      throw new Problem(
        502,
        "Current-day roster response exceeds the allowed size.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Problem(502, "Current-day roster returned invalid data.");
  }
}

export async function readCurrentDayRoster(
  enabled: Store[],
  request: typeof fetch = fetch,
  now = new Date(),
) {
  const businessDate = centralBusinessDate(now);
  const url = `${quEmployeeSalesBaseUrl}?businessDate=${businessDate}`;
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Problem(
      502,
      "Current-day roster could not be read. Last successful roster is retained.",
    );
  }
  let payload: unknown;
  try {
    payload = await boundedJson(response);
    const rows = parseCurrentDayRoster(payload, enabled);
    const locationsResponse = await request(quLocationsUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const locations = z.array(locationSchema).parse(
      await boundedJson(locationsResponse),
    );
    const byStore = new Map(
      locations.map((location) => [
        location.store_code.trim().toLowerCase(),
        String(location.api_store_id),
      ]),
    );
    const clockedIn: Roster["rows"][] = [];
    // Keep these reads sequential. The upstream Qu adapter can reject a burst
    // even though the same store requests succeed individually.
    for (const store of enabled.filter(
      // IDAD Resource's store-level clocked-in route explicitly excludes
      // Taco John's. Its identities continue to come from the sales feed.
      (store) =>
        store.posSource === "Qu" && !/^taco\s*john/i.test(store.brand),
    )) {
          const apiStoreId = byStore.get(store.id.toLowerCase());
          if (!apiStoreId)
            throw new Problem(
              502,
              "Current-day roster could not map an enabled store.",
            );
          const clockResponse = await request(
            `${quClockedInBaseUrl}?apiStoreId=${encodeURIComponent(apiStoreId)}`,
            {
              method: "GET",
              headers: { Accept: "application/json" },
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            },
          );
          const clock = clockedInSchema.parse(await boundedJson(clockResponse));
          clockedIn.push(clock.data.map((employee) => ({
            storeId: store.id,
            posSource: store.posSource,
            posEmployeeId: String(employee.employee_id).trim(),
            posName: [
              employee.employee_details.first_name,
              employee.employee_details.last_name,
            ]
              .filter(Boolean)
              .join(" ")
              .trim()
              .replace(/\s+/g, " "),
          })));
    }
    const unique = new Map(rows.map((row) => [identityKey(row), row]));
    for (const row of clockedIn.flat())
      if (row.posEmployeeId && row.posName) unique.set(identityKey(row), row);
    return { businessDate, rows: [...unique.values()] };
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(502, "Current-day roster returned invalid data.");
  }
}

export function mergeCurrentDayRoster(
  baseline: Roster,
  current: Awaited<ReturnType<typeof readCurrentDayRoster>>,
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
    source: `${baseline.source}+qu-current-day:${current.businessDate}`,
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
