import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import mapping from "../schedule/mapping.california.json";
import { inspectGoogleSchedule } from "../src/lib/google-schedule-access";
import { MAIN_ID, ROSTER_ID, BINDINGS_ID } from "../src/lib/google-draft";

const workbookId = "fixture_workbook_1234567890";

function credential() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    client_email: "fixture@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
}

async function withCredential(work: () => Promise<void>) {
  const previous = process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON;
  process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON = credential();
  try {
    await work();
  } finally {
    if (previous === undefined)
      delete process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON;
    else process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON = previous;
  }
}

function responseFor(
  url: string,
  options: RequestInit | undefined,
  sheets: {
    sheetId: number;
    title: string;
    rowCount: number;
    columnCount: number;
    hidden?: boolean;
  }[],
  canEdit = true,
) {
  if (url === "https://oauth2.googleapis.com/token")
    return Response.json({ access_token: "fictional" });
  assert.equal(options?.method, undefined);
  if (url.startsWith("https://www.googleapis.com/drive/v3/files/"))
    return Response.json({
      id: workbookId,
      name: "Fixture schedule",
      capabilities: { canEdit },
    });
  return Response.json({
    spreadsheetId: workbookId,
    properties: { title: "Fixture schedule" },
    sheets: sheets.map((sheet) => ({
      properties: {
        sheetId: sheet.sheetId,
        title: sheet.title,
        ...(sheet.hidden === undefined ? {} : { hidden: sheet.hidden }),
        gridProperties: {
          rowCount: sheet.rowCount,
          columnCount: sheet.columnCount,
        },
      },
    })),
  });
}

test("Texas preflight is read-only and distinguishes preparation from readiness", async () =>
  withCredential(async () => {
    const calls: { url: string; method?: string }[] = [],
      main = [
        {
          sheetId: MAIN_ID,
          title: "Texas Schedule",
          rowCount: 688,
          columnCount: 96,
        },
      ],
      request = async (url: URL | RequestInfo, options?: RequestInit) => {
        calls.push({ url: String(url), method: options?.method });
        return responseFor(String(url), options, main);
      };
    const result = await inspectGoogleSchedule(
      "texas",
      workbookId,
      "schedule",
      request as typeof fetch,
    );
    assert.equal(result.readiness, "needs-preparation");
    assert.deepEqual(
      calls.map((call) => call.method),
      ["POST", undefined, undefined],
    );
    assert.ok(calls.slice(1).every((call) => call.method === undefined));

    const prepared = await inspectGoogleSchedule(
      "texas",
      workbookId,
      "schedule",
      (async (url: URL | RequestInfo, options?: RequestInit) =>
        responseFor(String(url), options, [
          ...main,
          {
            sheetId: ROSTER_ID,
            title: "Directory Roster",
            rowCount: 5000,
            columnCount: 6,
            hidden: true,
          },
          {
            sheetId: BINDINGS_ID,
            title: "Directory Bindings",
            rowCount: 181,
            columnCount: 6,
            hidden: true,
          },
        ])) as typeof fetch,
    );
    assert.equal(prepared.readiness, "ready");
  }));

test("preflight requires Editor capability and preserves the previous target on denial", async () =>
  withCredential(async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        inspectGoogleSchedule("texas", workbookId, "schedule", (async (
          url: URL | RequestInfo,
          options?: RequestInit,
        ) => {
          calls.push(String(url));
          return responseFor(String(url), options, [], false);
        }) as typeof fetch),
      /as Editor/,
    );
    assert.equal(calls.length, 2);
    assert.ok(!calls.some((url) => url.includes("sheets.googleapis.com")));
  }));

test("Texas preflight rejects reserved helper sheet ID collisions", async () =>
  withCredential(async () => {
    await assert.rejects(
      () =>
        inspectGoogleSchedule("texas", workbookId, "schedule", (async (
          url: URL | RequestInfo,
          options?: RequestInit,
        ) =>
          responseFor(String(url), options, [
            {
              sheetId: MAIN_ID,
              title: "Texas Schedule",
              rowCount: 688,
              columnCount: 96,
            },
            {
              sheetId: ROSTER_ID,
              title: "Unrelated Sheet",
              rowCount: 5000,
              columnCount: 6,
            },
          ])) as typeof fetch),
      /helper layout is incomplete|identities conflict/,
    );
  }));

test("California preflight rejects missing reviewed tabs and accepts the exact layout", async () =>
  withCredential(async () => {
    await assert.rejects(
      () =>
        inspectGoogleSchedule("california", workbookId, "schedule", (async (
          url: URL | RequestInfo,
          options?: RequestInit,
        ) => responseFor(String(url), options, [])) as typeof fetch),
      /California schedule layout is incompatible/,
    );
    const result = await inspectGoogleSchedule(
      "california",
      workbookId,
      "schedule",
      (async (url: URL | RequestInfo, options?: RequestInit) =>
        responseFor(String(url), options, [
          {
            sheetId: mapping.schedule.sheetId,
            title: mapping.schedule.sheet,
            rowCount: mapping.schedule.rowCount,
            columnCount: mapping.schedule.columnCount,
          },
          {
            sheetId: mapping.master.sheetId,
            title: mapping.master.sheet,
            rowCount: mapping.master.rowCount,
            columnCount: mapping.master.columnCount,
          },
        ])) as typeof fetch,
    );
    assert.equal(result.readiness, "needs-preparation");
  }));
