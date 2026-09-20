import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mapping from "../schedule/mapping.california.json";
import {
  assertCaliforniaDraftReadback,
  californiaMasterFromGrid,
  planCaliforniaDraftPreparation,
  planCaliforniaDraftSync,
} from "../src/lib/california-draft-schedule";
import {
  CALIFORNIA_DRAFT_ID,
  californiaDraftClient,
} from "../src/lib/google-california-draft";
import {
  textValue,
  type DraftGrid,
  type GridCell,
} from "../src/lib/draft-schedule";
import type { Employee } from "../src/lib/model";
import { seed } from "../src/lib/seed";

function set(
  grid: DraftGrid,
  sheetId: number,
  row: number,
  column: number,
  value: string,
) {
  const sheet = grid.sheets.find(
      (candidate) => candidate.properties.sheetId === sheetId,
    )!,
    rows = sheet.data![0].rowData!;
  rows[row - 1] ??= { values: [] };
  const existing = rows[row - 1].values![column - 1];
  rows[row - 1].values![column - 1] = {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
    ...(existing?.dataValidation
      ? { dataValidation: existing.dataValidation }
      : {}),
  };
}

function employee(storeId: string, index: number): Employee {
  return {
    ...seed().employees[0],
    id: `directory-${index}`,
    personId: `person-${index}`,
    storeId,
    posSource: "Toast",
    posEmployeeId: `toast-${index}`,
    posName: `Jamie Store${index}`,
    firstName: "Jamie",
    lastName: `Store${index}`,
    preferredName: "",
    status: "active",
    verification: "confirmed",
  };
}

function grid(employees: Employee[]) {
  const result: DraftGrid = {
    spreadsheetId: CALIFORNIA_DRAFT_ID,
    sheets: [
      {
        properties: {
          sheetId: mapping.schedule.sheetId,
          title: mapping.schedule.sheet,
          gridProperties: {
            rowCount: mapping.schedule.rowCount,
            columnCount: mapping.schedule.columnCount,
          },
        },
        data: [
          {
            rowData: Array.from({ length: 430 }, () => ({ values: [] })),
          },
        ],
      },
      {
        properties: {
          sheetId: mapping.master.sheetId,
          title: mapping.master.sheet,
          gridProperties: {
            rowCount: mapping.master.rowCount,
            columnCount: mapping.master.columnCount,
          },
        },
        data: [
          {
            rowData: Array.from({ length: 1000 }, () => ({ values: [] })),
          },
        ],
      },
    ],
  };
  mapping.stores.forEach((store, index) => {
    set(
      result,
      mapping.master.sheetId,
      11,
      store.nameColumn,
      store.sourceHeader,
    );
    set(result, mapping.master.sheetId, 13, store.nameColumn, "Name");
    set(result, mapping.master.sheetId, 13, store.idColumn, "ID");
    const item = employees[index],
      label = `Jamie S.`;
    set(result, mapping.master.sheetId, 15, store.nameColumn, label);
    set(result, mapping.master.sheetId, 15, store.idColumn, item.id);
    set(
      result,
      mapping.schedule.sheetId,
      store.scheduleStartRow,
      mapping.schedule.nameColumn,
      label,
    );
  });
  return result;
}

function apply(grid: DraftGrid, requests: Record<string, unknown>[]) {
  for (const request of requests) {
    const value = request as any;
    if (value.updateCells) {
      const range = value.updateCells.range;
      value.updateCells.rows.forEach((row: any, rowOffset: number) =>
        row.values.forEach((entry: GridCell, columnOffset: number) => {
          const targetRow = range.startRowIndex + rowOffset + 1,
            targetColumn = range.startColumnIndex + columnOffset + 1,
            stringValue = entry.userEnteredValue?.stringValue;
          set(grid, range.sheetId, targetRow, targetColumn, stringValue || "");
        }),
      );
    }
    if (value.setDataValidation) {
      const range = value.setDataValidation.range;
      for (let row = range.startRowIndex; row < range.endRowIndex; row++) {
        const sheet = grid.sheets.find(
            (candidate) => candidate.properties.sheetId === range.sheetId,
          )!,
          values = sheet.data![0].rowData![row].values!;
        values[range.startColumnIndex] ??= {};
        values[range.startColumnIndex].dataValidation =
          value.setDataValidation.rule;
      }
    }
  }
}

test("reviewed California mapping covers 105 column-R staff cells", () => {
  assert.equal(mapping.schedule.nameColumn, 18);
  assert.equal(
    mapping.stores.reduce(
      (count, store) =>
        count + store.scheduleEndRow - store.scheduleStartRow + 1,
      0,
    ),
    105,
  );
  assert.deepEqual(
    mapping.stores.map((store) => store.storeId).sort(),
    ["JJ-025", "JJ-104833", "JJ-125", "JJ-171", "JJ-548", "JJ-552"].sort(),
  );
});

test("California sync controls master labels and validation without writing selected names", () => {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index),
    ),
    draft = grid(employees);
  employees[0].preferredName = "Jay";
  const plan = planCaliforniaDraftSync(draft, employees);
  assert.equal(plan.active, 6);
  assert.ok(
    plan.roster.some(
      (row) => row.storeId === "JJ-025" && row.label === "Jamie S.",
    ),
  );
  assert.ok(
    plan.roster.some((row) => row.storeId === "JJ-025" && row.label === "Jay"),
  );
  assert.ok(
    plan.requests.every(
      (request: any) =>
        !request.updateCells ||
        request.updateCells.range.sheetId === mapping.master.sheetId,
    ),
  );
  assert.equal(
    plan.requests.filter((request: any) => request.setDataValidation).length,
    6,
  );
  apply(draft, plan.requests);
  assertCaliforniaDraftReadback(draft, plan.roster);
  assert.equal(
    californiaMasterFromGrid(draft).filter((row) => row.storeId === "JJ-025")
      .length,
    2,
  );
});

test("California sync reconciles one unique store-scoped legacy name", () => {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index),
    ),
    draft = grid(employees),
    row = mapping.stores[0].scheduleStartRow;
  set(
    draft,
    mapping.schedule.sheetId,
    row,
    mapping.schedule.nameColumn,
    "Jamie",
  );
  const plan = planCaliforniaDraftSync(draft, employees);
  assert.deepEqual(plan.reconciliation, {
    reconciled: [
      {
        cell: `R${row}`,
        row,
        storeId: mapping.stores[0].storeId,
        from: "Jamie",
        to: "Jamie S.",
      },
    ],
    unmatched: [],
  });
  assert.ok(
    plan.requests.some(
      (request: any) =>
        request.updateCells?.range.sheetId === mapping.schedule.sheetId,
    ),
  );
  apply(draft, plan.requests);
  assertCaliforniaDraftReadback(
    draft,
    plan.roster,
    CALIFORNIA_DRAFT_ID,
    plan.reconciliation,
  );
  assert.equal(
    textValue(
      draft.sheets[0].data![0].rowData![row - 1].values![
        mapping.schedule.nameColumn - 1
      ],
    ),
    "Jamie S.",
  );
});

test("California sync reports an unbound typed schedule name", () => {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index),
    ),
    draft = grid(employees);
  set(
    draft,
    mapping.schedule.sheetId,
    mapping.stores[0].scheduleStartRow + 1,
    mapping.schedule.nameColumn,
    "Unknown P.",
  );
  const plan = planCaliforniaDraftSync(draft, employees);
  assert.deepEqual(
    plan.reconciliation.unmatched.find((miss) => miss.value === "Unknown P."),
    {
      cell: `R${mapping.stores[0].scheduleStartRow + 1}`,
      row: mapping.stores[0].scheduleStartRow + 1,
      storeId: mapping.stores[0].storeId,
      value: "Unknown P.",
      reason: "no-match",
      candidates: [],
    },
  );
  apply(draft, plan.requests);
  assertCaliforniaDraftReadback(
    draft,
    plan.roster,
    CALIFORNIA_DRAFT_ID,
    plan.reconciliation,
  );
});

test("California sync leaves an ambiguous first name unchanged", () => {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index),
    ),
    second = employee(mapping.stores[0].storeId, 99),
    draft = grid(employees),
    row = mapping.stores[0].scheduleStartRow;
  second.lastName = "Second";
  employees.push(second);
  set(
    draft,
    mapping.schedule.sheetId,
    row,
    mapping.schedule.nameColumn,
    "Jamie",
  );
  const plan = planCaliforniaDraftSync(draft, employees),
    miss = plan.reconciliation.unmatched.find(
      (candidate) => candidate.cell === `R${row}`,
    );
  assert.equal(miss?.reason, "ambiguous");
  assert.deepEqual(miss?.candidates, ["Jamie S.", "Jamie Second"]);
  assert.ok(
    !plan.requests.some(
      (request: any) =>
        request.updateCells?.range.sheetId === mapping.schedule.sheetId &&
        request.updateCells.range.endRowIndex === row,
    ),
  );
});

test("California first-sync preparation seeds only reviewed master ranges and is idempotent", () => {
  const employees = mapping.stores.map((store, index) =>
      employee(store.storeId, index),
    ),
    draft = grid(employees);
  for (const store of mapping.stores) {
    set(draft, mapping.master.sheetId, 15, store.nameColumn, "");
    set(draft, mapping.master.sheetId, 15, store.idColumn, "");
    set(
      draft,
      mapping.schedule.sheetId,
      store.scheduleStartRow,
      mapping.schedule.nameColumn,
      "",
    );
  }
  const preparation = planCaliforniaDraftPreparation(draft, employees);
  assert.equal(preparation.prepared, true);
  assert.equal(preparation.requests.length, mapping.stores.length);
  assert.ok(
    preparation.requests.every(
      (request: any) =>
        request.updateCells?.range.sheetId === mapping.master.sheetId,
    ),
  );
  apply(draft, preparation.requests);
  const repeated = planCaliforniaDraftPreparation(draft, employees);
  assert.equal(repeated.prepared, false);
  assert.deepEqual(repeated.requests, []);
});

test("California transport allows mapped reconciliation and rejects unrelated validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portal-california-draft-")),
    names = [
      "PORTAL_MODE",
      "PORTAL_CALIFORNIA_DRAFT_ID",
      "PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE",
    ],
    old = names.map((name) => process.env[name]);
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      file = join(directory, "fixture.json");
    await writeFile(
      file,
      JSON.stringify({
        type: "service_account",
        client_email: "fixture@example.invalid",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
      { mode: 0o600 },
    );
    process.env.PORTAL_MODE = "mongo-test";
    process.env.PORTAL_CALIFORNIA_DRAFT_ID = CALIFORNIA_DRAFT_ID;
    process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE = file;
    const writes: string[] = [],
      client = await californiaDraftClient(async (url, options) => {
        if (String(url) === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: "fictional" });
        writes.push(String(url));
        return Response.json({ spreadsheetId: CALIFORNIA_DRAFT_ID });
      }),
      update = {
        updateCells: {
          range: {
            sheetId: mapping.master.sheetId,
            startRowIndex: 14,
            endRowIndex: 15,
            startColumnIndex: 1,
            endColumnIndex: 3,
          },
          rows: [
            {
              values: ["Jamie S.", "directory-1"].map((value) => ({
                userEnteredValue: { stringValue: value },
              })),
            },
          ],
          fields: "userEnteredValue",
        },
      };
    await assert.rejects(
      () =>
        client.write([
          {
            updateCells: {
              ...update.updateCells,
              range: {
                ...update.updateCells.range,
                sheetId: mapping.schedule.sheetId,
              },
            },
          },
        ]),
      /rejected/,
    );
    await assert.rejects(
      () =>
        client.write([
          {
            setDataValidation: {
              range: {
                sheetId: mapping.schedule.sheetId,
                startRowIndex: 20,
                endRowIndex: 40,
                startColumnIndex: 16,
                endColumnIndex: 17,
              },
            },
          },
        ]),
      /rejected/,
    );
    assert.equal(writes.length, 0);
    await client.write([update]);
    await client.write([
      {
        updateCells: {
          range: {
            sheetId: mapping.schedule.sheetId,
            startRowIndex: mapping.stores[0].scheduleStartRow - 1,
            endRowIndex: mapping.stores[0].scheduleStartRow,
            startColumnIndex: mapping.schedule.nameColumn - 1,
            endColumnIndex: mapping.schedule.nameColumn,
          },
          rows: [
            {
              values: [{ userEnteredValue: { stringValue: "Jamie S." } }],
            },
          ],
          fields: "userEnteredValue",
        },
      },
    ]);
    assert.deepEqual(writes, [
      `https://sheets.googleapis.com/v4/spreadsheets/${CALIFORNIA_DRAFT_ID}:batchUpdate`,
      `https://sheets.googleapis.com/v4/spreadsheets/${CALIFORNIA_DRAFT_ID}:batchUpdate`,
    ]);
  } finally {
    names.forEach((name, index) => {
      if (old[index] === undefined) delete process.env[name];
      else process.env[name] = old[index];
    });
    await rm(directory, { recursive: true });
  }
});
