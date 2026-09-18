import { createSign } from "node:crypto";
import mapping from "../../schedule/mapping.california.json";
import { mode } from "./config";
import { googleCredential } from "./google-credential";
import { Problem } from "./model";

export const CALIFORNIA_DRAFT_ID = mapping.spreadsheetId;

async function json(response: Response) {
  if (!response.ok || !response.body)
    throw new Problem(
      502,
      `California draft Google request failed (${response.status}). Check draft-only access.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 8_000_000)
      throw new Problem(502, "California draft response too large.");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function californiaDraftClient(request: typeof fetch = fetch) {
  if (
    !["mongo-test", "mongo-production"].includes(
      process.env.PORTAL_MODE || "",
    ) ||
    process.env.PORTAL_CALIFORNIA_DRAFT_ID !== CALIFORNIA_DRAFT_ID
  )
    throw new Problem(
      503,
      "The isolated California draft connection is not enabled.",
    );
  if (process.env.PORTAL_MODE === "mongo-production") mode();
  const key = await googleCredential("draft"),
    now = Math.floor(Date.now() / 1000),
    enc = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url"),
    unsigned =
      enc({ alg: "RS256", typ: "JWT" }) +
      "." +
      enc({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(key.private_key, "base64url"),
    auth = await json(
      await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: unsigned + "." + signature,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }),
    );
  if (typeof auth.access_token !== "string")
    throw new Problem(502, "Google token missing.");
  const headers = {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/json",
    },
    base = `https://sheets.googleapis.com/v4/spreadsheets/${CALIFORNIA_DRAFT_ID}`;
  return {
    async read() {
      const meta = await json(
        await request(base + "?fields=spreadsheetId,sheets(properties)", {
          headers,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        }),
      );
      for (const expected of [mapping.schedule, mapping.master])
        if (
          !meta.sheets.some(
            (sheet: any) =>
              sheet.properties.sheetId === expected.sheetId &&
              sheet.properties.title === expected.sheet,
          )
        )
          throw new Problem(409, "California draft sheet identity changed.");
      const query = new URLSearchParams({
        includeGridData: "true",
        fields:
          "spreadsheetId,sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation))))",
      });
      query.append(
        "ranges",
        `'${mapping.master.sheet}'!B11:R${mapping.master.endRow}`,
      );
      query.append(
        "ranges",
        `'${mapping.schedule.sheet}'!R1:R${Math.max(...mapping.stores.map((store) => store.scheduleEndRow))}`,
      );
      return json(
        await request(base + "?" + query, {
          headers,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        }),
      );
    },
    async write(requests: Record<string, unknown>[]) {
      for (const request of requests) {
        const value = request as any;
        if (Object.keys(request).length !== 1)
          throw new Problem(400, "Invalid California draft write.");
        if (value.updateCells) {
          const update = value.updateCells,
            range = update.range,
            store = mapping.stores.find(
              (candidate) =>
                range?.sheetId === mapping.master.sheetId &&
                range.startColumnIndex === candidate.nameColumn - 1 &&
                range.endColumnIndex === candidate.idColumn,
            );
          if (
            !store ||
            Object.keys(update).some(
              (key) => !["range", "rows", "fields"].includes(key),
            ) ||
            update.fields !== "userEnteredValue" ||
            range.startRowIndex !== mapping.master.startRow - 1 ||
            range.endRowIndex > mapping.master.endRow ||
            range.endRowIndex <= range.startRowIndex ||
            !Array.isArray(update.rows) ||
            update.rows.length !== range.endRowIndex - range.startRowIndex ||
            update.rows.some(
              (row: any) =>
                !Array.isArray(row.values) || row.values.length !== 2,
            )
          )
            throw new Problem(
              400,
              "Write outside California employee master rejected.",
            );
        } else if (value.setDataValidation) {
          const range = value.setDataValidation.range;
          if (
            range?.sheetId !== mapping.schedule.sheetId ||
            range.startColumnIndex !== mapping.schedule.nameColumn - 1 ||
            range.endColumnIndex !== mapping.schedule.nameColumn ||
            !mapping.stores.some(
              (store) =>
                range.startRowIndex === store.scheduleStartRow - 1 &&
                range.endRowIndex === store.scheduleEndRow,
            )
          )
            throw new Problem(
              400,
              "Write outside mapped California name validation rejected.",
            );
        } else throw new Problem(400, "Unsupported California draft mutation.");
      }
      return json(
        await request(base + ":batchUpdate", {
          method: "POST",
          headers,
          body: JSON.stringify({ requests }),
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        }),
      );
    },
  };
}
