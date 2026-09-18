import { createSign } from "node:crypto";
import californiaMapping from "../../schedule/mapping.california.json";
import { googleCredential } from "./google-credential";
import { MAIN_ID, ROSTER_ID, BINDINGS_ID } from "./google-draft";
import { Problem, type ScheduleTargetState } from "./model";

type SheetMetadata = {
  sheetId: number;
  title: string;
  hidden?: boolean;
  gridProperties: { rowCount: number; columnCount: number };
};

async function json(response: Response) {
  if (!response.ok || !response.body) {
    if (response.status === 403 || response.status === 404)
      throw new Problem(
        409,
        "Share the selected schedule with the directory schedule writer as Editor, then retry.",
      );
    throw new Problem(
      502,
      `Google schedule preflight failed (${response.status}).`,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 2_000_000)
      throw new Problem(502, "Google response was too large.");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function accessToken(request: typeof fetch) {
  const key = await googleCredential("draft"),
    now = Math.floor(Date.now() / 1000),
    encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url"),
    unsigned =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: key.client_email,
        scope:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    assertion =
      unsigned +
      "." +
      createSign("RSA-SHA256")
        .update(unsigned)
        .sign(key.private_key, "base64url");
  const auth = await json(
    await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (typeof auth.access_token !== "string")
    throw new Problem(502, "Google token missing.");
  return auth.access_token as string;
}

export async function inspectGoogleSchedule(
  state: ScheduleTargetState,
  spreadsheetId: string,
  kind: "test" | "schedule",
  request: typeof fetch = fetch,
) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId))
    throw new Problem(400, "Invalid schedule identity.");
  const token = await accessToken(request),
    headers = { Authorization: `Bearer ${token}` },
    drive = await json(
      await request(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=id,name,capabilities(canEdit)&supportsAllDrives=true`,
        {
          headers,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      ),
    );
  if (drive.id !== spreadsheetId || drive.capabilities?.canEdit !== true)
    throw new Problem(
      409,
      "Share the selected schedule with the directory schedule writer as Editor, then retry.",
    );
  const spreadsheet = await json(
      await request(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties))`,
        {
          headers,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      ),
    ),
    sheets = (spreadsheet.sheets || []).map(
      (sheet: { properties: SheetMetadata }) => sheet.properties,
    ) as SheetMetadata[];
  if (spreadsheet.spreadsheetId !== spreadsheetId)
    throw new Problem(409, "Google returned a different schedule identity.");

  if (state === "texas") {
    const main = sheets.find((sheet) => sheet.sheetId === MAIN_ID);
    if (
      main?.title !== "Texas Schedule" ||
      main.gridProperties.rowCount !== 688 ||
      main.gridProperties.columnCount !== 96
    )
      throw new Problem(
        409,
        "The selected Texas schedule layout is incompatible.",
      );
    const roster = sheets.find((sheet) => sheet.sheetId === ROSTER_ID),
      bindings = sheets.find((sheet) => sheet.sheetId === BINDINGS_ID),
      rosterTitle = sheets.find((sheet) => sheet.title === "Directory Roster"),
      bindingTitle = sheets.find(
        (sheet) => sheet.title === "Directory Bindings",
      );
    if (!!roster !== !!bindings || !!rosterTitle !== !!bindingTitle)
      throw new Problem(409, "The selected Texas helper layout is incomplete.");
    if (
      (roster && roster.title !== "Directory Roster") ||
      (bindings && bindings.title !== "Directory Bindings") ||
      (rosterTitle && rosterTitle.sheetId !== ROSTER_ID) ||
      (bindingTitle && bindingTitle.sheetId !== BINDINGS_ID)
    )
      throw new Problem(
        409,
        "Reserved Texas helper sheet identities conflict.",
      );
    if (
      roster &&
      bindings &&
      (roster.hidden !== true ||
        roster.gridProperties.rowCount !== 5000 ||
        roster.gridProperties.columnCount !== 6 ||
        bindings.hidden !== true ||
        bindings.gridProperties.rowCount !== 181 ||
        bindings.gridProperties.columnCount !== 6)
    )
      throw new Problem(
        409,
        "The selected Texas helper layout is incompatible.",
      );
    return {
      title: String(
        spreadsheet.properties?.title || drive.name || "Texas schedule",
      ),
      readiness:
        kind === "test"
          ? ("test-draft" as const)
          : roster && bindings
            ? ("ready" as const)
            : ("needs-preparation" as const),
    };
  }

  for (const expected of [
    californiaMapping.schedule,
    californiaMapping.master,
  ]) {
    const actual = sheets.find((sheet) => sheet.sheetId === expected.sheetId);
    if (
      actual?.title !== expected.sheet ||
      actual.gridProperties.rowCount !== expected.rowCount ||
      actual.gridProperties.columnCount !== expected.columnCount
    )
      throw new Problem(
        409,
        "The selected California schedule layout is incompatible.",
      );
  }
  return {
    title: String(
      spreadsheet.properties?.title || drive.name || "California schedule",
    ),
    readiness:
      kind === "test"
        ? ("test-draft" as const)
        : ("needs-preparation" as const),
  };
}
