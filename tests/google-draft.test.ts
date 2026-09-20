import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  draftClient,
  DRAFT_ID,
  BINDINGS_ID,
  MAIN_ID,
  ROSTER_ID,
} from "../src/lib/google-draft";
test("draft transport rejects manager-cell, unrelated-sheet, oversized and ambiguous writes before network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portal-draft-test-"));
  const names = [
    "PORTAL_MODE",
    "PORTAL_DRAFT_ID",
    "PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE",
  ];
  const old = names.map((n) => process.env[n]);
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(dir, "fixture.json");
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
    process.env.PORTAL_DRAFT_ID = DRAFT_ID;
    process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE = file;
    const writes: string[] = [];
    const client = await draftClient(async (url, options) => {
      if (String(url) === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "fictional" });
      assert.equal(options?.redirect, "error");
      writes.push(String(url));
      return Response.json({ spreadsheetId: DRAFT_ID });
    });
    const range = {
      sheetId: ROSTER_ID,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 6,
    };
    const update = {
      range,
      rows: [
        {
          values: Array.from({ length: 6 }, () => ({
            userEnteredValue: { stringValue: "fixture" },
          })),
        },
      ],
      fields: "userEnteredValue",
    };
    for (const bad of [
      { updateCells: { ...update, range: { ...range, sheetId: MAIN_ID } } },
      {
        updateCells: {
          ...update,
          start: { sheetId: MAIN_ID, rowIndex: 21, columnIndex: 13 },
        },
      },
      { updateCells: { ...update, rows: [...update.rows, ...update.rows] } },
      { updateCells: { ...update, fields: "*" } },
      { deleteSheet: { sheetId: MAIN_ID } },
      {
        setDataValidation: {
          range: {
            sheetId: MAIN_ID,
            startRowIndex: 21,
            endRowIndex: 22,
            startColumnIndex: 15,
            endColumnIndex: 16,
          },
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: MAIN_ID, gridProperties: { rowCount: 5000 } },
          fields: "gridProperties.rowCount",
        },
      },
    ])
      await assert.rejects(
        () => client.write([bad]),
        /rejected|Unsupported|capacity/,
      );
    assert.equal(writes.length, 0);
    await client.write([{ updateCells: update }]);
    await client.write([
      {
        updateCells: {
          range: {
            sheetId: MAIN_ID,
            startRowIndex: 21,
            endRowIndex: 22,
            startColumnIndex: 13,
            endColumnIndex: 14,
          },
          rows: [
            {
              values: [{ userEnteredValue: { stringValue: "Jamie C." } }],
            },
          ],
          fields: "userEnteredValue",
        },
      },
    ]);
    assert.deepEqual(writes, [
      `https://sheets.googleapis.com/v4/spreadsheets/${DRAFT_ID}:batchUpdate`,
      `https://sheets.googleapis.com/v4/spreadsheets/${DRAFT_ID}:batchUpdate`,
    ]);
  } finally {
    names.forEach((n, i) => {
      if (old[i] === undefined) delete process.env[n];
      else process.env[n] = old[i];
    });
    await rm(dir, { recursive: true });
  }
});

test("first Texas sync preparation creates only the reviewed hidden helper structure and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portal-draft-prepare-")),
    originalId = "original_texas_1234567890123",
    names = [
      "PORTAL_MODE",
      "PORTAL_DRAFT_ID",
      "PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE",
      "PORTAL_SCHEDULE_CATALOG_MONGODB_URI",
    ],
    old = names.map((name) => process.env[name]);
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      file = join(dir, "fixture.json");
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
    process.env.PORTAL_DRAFT_ID = DRAFT_ID;
    process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_FILE = file;
    process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI =
      "mongodb://fixture.invalid";
    let prepared = false;
    const batches: any[] = [],
      metadata = () => ({
        spreadsheetId: originalId,
        sheets: [
          {
            properties: {
              sheetId: MAIN_ID,
              title: "Texas Schedule",
              gridProperties: { rowCount: 688, columnCount: 96 },
            },
          },
          ...(prepared
            ? [
                {
                  properties: {
                    sheetId: ROSTER_ID,
                    title: "Directory Roster",
                    hidden: true,
                    gridProperties: { rowCount: 5000, columnCount: 6 },
                  },
                },
                {
                  properties: {
                    sheetId: BINDINGS_ID,
                    title: "Directory Bindings",
                    hidden: true,
                    gridProperties: { rowCount: 181, columnCount: 6 },
                  },
                },
              ]
            : []),
        ],
      }),
      client = await draftClient(async (url, options) => {
        if (String(url) === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: "fictional" });
        if (options?.method === "POST") {
          batches.push(JSON.parse(String(options.body)));
          prepared = true;
          return Response.json({ spreadsheetId: originalId });
        }
        return Response.json(metadata());
      }, originalId);
    const roster = [
      ["TX-162", "directory-1", "pos-1", "Qu", "Jamie S.", "Jamie Store"],
    ];
    assert.equal(await client.prepare(roster), true);
    assert.equal(await client.prepare(roster), false);
    assert.equal(batches.length, 1);
    const requests = batches[0].requests;
    assert.deepEqual(
      requests.slice(0, 2).map((request: any) => request.addSheet.properties),
      [
        {
          sheetId: ROSTER_ID,
          title: "Directory Roster",
          hidden: true,
          gridProperties: { rowCount: 5000, columnCount: 6 },
        },
        {
          sheetId: BINDINGS_ID,
          title: "Directory Bindings",
          hidden: true,
          gridProperties: { rowCount: 181, columnCount: 6 },
        },
      ],
    );
    assert.ok(
      requests
        .filter((request: any) => request.updateCells)
        .every((request: any) =>
          [ROSTER_ID, BINDINGS_ID].includes(request.updateCells.range.sheetId),
        ),
    );
    assert.ok(
      requests.every(
        (request: any) => request.updateCells?.range.sheetId !== MAIN_ID,
      ),
    );
  } finally {
    names.forEach((name, index) => {
      if (old[index] === undefined) delete process.env[name];
      else process.env[name] = old[index];
    });
    await rm(dir, { recursive: true });
  }
});
