import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  draftClient,
  DRAFT_ID,
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
    assert.deepEqual(writes, [
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
