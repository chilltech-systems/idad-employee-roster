import test from "node:test";
import assert from "node:assert/strict";
import {
  centralBusinessDate,
  mergeCurrentDayRoster,
  parseCurrentDayRoster,
  quClockedInBaseUrl,
  quEmployeeSalesBaseUrl,
  quLocationsUrl,
  readCurrentDayRoster,
  retainPreviousRoster,
} from "../src/lib/current-day-roster";
import type { Roster, Store } from "../src/lib/model";

const stores: Store[] = [
  {
    id: "TX-200",
    posSource: "Qu",
    state: "Texas",
    brand: "Auntie Anne’s",
    name: "Fixture",
  },
  {
    id: "TX-219",
    posSource: "Qu",
    state: "Texas",
    brand: "Auntie Anne’s",
    name: "Other fixture",
  },
  {
    id: "TJ-1031",
    posSource: "Qu",
    state: "Colorado",
    brand: "Taco John's",
    name: "Excluded labor fixture",
  },
];

test("formats the current business date in America/Chicago", () => {
  assert.equal(
    centralBusinessDate(new Date("2026-09-18T02:00:00.000Z")),
    "09172026",
  );
  assert.equal(
    centralBusinessDate(new Date("2026-01-01T05:30:00.000Z")),
    "12312025",
  );
});

test("parses enabled Qu stores, normalizes names and ignores unusable identities", () => {
  const rows = parseCurrentDayRoster(
    [
      {
        store_code: "tx-200",
        employeeSales: [
          { employee_id: "00123", name: "  New   Employee " },
          { employee_id: 456, name: "Numeric ID" },
          { employee_id: null, name: "Missing ID" },
          { employee_id: "789", name: " " },
          { employee_id: "00123", name: "Duplicate" },
        ],
      },
      {
        store_code: "tx-999",
        employeeSales: [{ employee_id: "900", name: "Disabled Store" }],
      },
    ],
    stores,
  );
  assert.deepEqual(rows, [
    {
      storeId: "TX-200",
      posSource: "Qu",
      posEmployeeId: "00123",
      posName: "New Employee",
    },
    {
      storeId: "TX-200",
      posSource: "Qu",
      posEmployeeId: "456",
      posName: "Numeric ID",
    },
  ]);
});

test("reads the fixed uncached current-day endpoint", async () => {
  const requested: string[] = [];
  const result = await readCurrentDayRoster(
    stores,
    (async (url, options) => {
      requested.push(String(url));
      assert.equal(options?.method, "GET");
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.redirect, "error");
      if (String(url) === quLocationsUrl)
        return Response.json([
          { store_code: "TX-200", api_store_id: "200" },
          { store_code: "TX-219", api_store_id: "219" },
        ]);
      if (String(url) === `${quClockedInBaseUrl}?apiStoreId=200`)
        return Response.json({ data: [] });
      if (String(url) === `${quClockedInBaseUrl}?apiStoreId=219`)
        return Response.json({
          data: [
            {
              employee_id: 777,
              employee_details: { first_name: "Clocked", last_name: "In" },
            },
          ],
        });
      return Response.json([
        {
          store_code: "tx-219",
          employeeSales: [{ employee_id: "fresh-1", name: "Fresh Hire" }],
        },
      ]);
    }) as typeof fetch,
    new Date("2026-09-17T17:00:00.000Z"),
  );
  assert.ok(
    requested.includes(`${quEmployeeSalesBaseUrl}?businessDate=09172026`),
  );
  assert.ok(requested.includes(quLocationsUrl));
  assert.equal(result.businessDate, "09172026");
  assert.ok(result.rows.some((row) => row.posEmployeeId === "fresh-1"));
  assert.ok(
    result.rows.some(
      (row) => row.posEmployeeId === "777" && row.posName === "Clocked In",
    ),
  );
});

test("merges current activity additively and lets a current name verify the identity", () => {
  const baseline: Roster = {
    source: "fixture-baseline",
    complete: true,
    observedAt: "2026-09-13T10:00:00.000Z",
    stores: ["TX-200", "TX-219"],
    rowCount: 2,
    rows: [
      {
        storeId: "TX-200",
        posSource: "Qu",
        posEmployeeId: "00123",
        posName: "Old Name",
      },
      {
        storeId: "TX-219",
        posSource: "Qu",
        posEmployeeId: "00999",
        posName: "Historical Employee",
      },
    ],
  };
  const merged = mergeCurrentDayRoster(
    baseline,
    {
      businessDate: "09172026",
      rows: [
        {
          storeId: "TX-200",
          posSource: "Qu",
          posEmployeeId: "00123",
          posName: "Current Name",
        },
        {
          storeId: "TX-200",
          posSource: "Qu",
          posEmployeeId: "fresh-1",
          posName: "Fresh Hire",
        },
      ],
    },
    "2026-09-17T17:00:00.000Z",
  );
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.stores, baseline.stores);
  assert.equal(merged.rowCount, 3);
  assert.ok(merged.rows.some((row) => row.posName === "Historical Employee"));
  assert.ok(merged.rows.some((row) => row.posName === "Current Name"));
  assert.ok(merged.rows.some((row) => row.posEmployeeId === "fresh-1"));
  assert.equal(merged.source, "fixture-baseline+qu-current-day:09172026");
});

test("rejects unavailable or malformed current-day responses", async () => {
  await assert.rejects(
    readCurrentDayRoster(
      stores,
      (async () => new Response("no", { status: 503 })) as typeof fetch,
    ),
    /Last successful roster is retained/,
  );
  await assert.rejects(
    readCurrentDayRoster(
      stores,
      (async () => new Response("not json")) as typeof fetch,
    ),
    /invalid data/,
  );
});

test("retains the last accepted snapshot without reviving removed stores", () => {
  const current: Roster = {
    source: "current",
    complete: true,
    observedAt: "2026-09-17T17:00:00.000Z",
    stores: ["TX-200"],
    rowCount: 1,
    rows: [
      {
        storeId: "TX-200",
        posSource: "Qu",
        posEmployeeId: "00123",
        posName: "Current Name",
      },
    ],
  };
  const previous: Roster = {
    ...current,
    source: "previous",
    stores: ["TX-200", "TX-219"],
    rowCount: 3,
    rows: [
      {
        storeId: "TX-200",
        posSource: "Qu",
        posEmployeeId: "00123",
        posName: "Old Name",
      },
      {
        storeId: "TX-200",
        posSource: "Qu",
        posEmployeeId: "00456",
        posName: "Retained Employee",
      },
      {
        storeId: "TX-219",
        posSource: "Qu",
        posEmployeeId: "00999",
        posName: "Removed Store",
      },
    ],
  };
  const retained = retainPreviousRoster(current, previous);
  assert.equal(retained.source, "current");
  assert.equal(retained.rowCount, 2);
  assert.ok(retained.rows.some((row) => row.posName === "Current Name"));
  assert.ok(retained.rows.some((row) => row.posName === "Retained Employee"));
  assert.ok(!retained.rows.some((row) => row.storeId === "TX-219"));
});
