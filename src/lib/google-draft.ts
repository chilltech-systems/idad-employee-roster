import { createSign } from "node:crypto";
import mapping from "../../schedule/mapping.texas.json";
import { googleCredential } from "./google-credential";
import { Problem } from "./model";
import { mode } from "./config";
export const DRAFT_ID = "1ugYhBd-Bw5kOTyGMWgi6vJsvK-KXMqeZ032lOZo6xZc";
export const MAIN_ID = 1883086419,
  ROSTER_ID = 910102,
  BINDINGS_ID = 910103;
async function json(response: Response) {
  if (!response.ok || !response.body)
    throw new Problem(
      502,
      `Draft Google request failed (${response.status}). Check draft-only access.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 8_000_000) throw new Problem(502, "Draft response too large.");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function draftClient(
  request: typeof fetch = fetch,
  spreadsheetId = DRAFT_ID,
) {
  if (
    !["mongo-test", "mongo-production"].includes(
      process.env.PORTAL_MODE || "",
    ) ||
    process.env.PORTAL_DRAFT_ID !== DRAFT_ID ||
    (spreadsheetId !== DRAFT_ID &&
      !process.env.PORTAL_SCHEDULE_CATALOG_MONGODB_URI) ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)
  )
    throw new Problem(503, "The isolated draft connection is not enabled.");
  if (process.env.PORTAL_MODE === "mongo-production") mode();
  const key = await googleCredential("draft");
  const now = Math.floor(Date.now() / 1000),
    enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key.private_key, "base64url");
  const auth = await json(
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
  };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  async function metadata() {
    const meta = await json(
      await request(
        base + "?fields=spreadsheetId,sheets(properties,protectedRanges)",
        {
          headers,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      ),
    );
    if (meta.spreadsheetId !== spreadsheetId)
      throw new Problem(409, "Draft schedule identity changed.");
    return meta;
  }
  return {
    metadata,
    async prepare(roster: string[][]) {
      const meta = await metadata(),
        main = meta.sheets.find(
          (sheet: any) => sheet.properties.sheetId === MAIN_ID,
        )?.properties;
      if (
        main?.title !== "Texas Schedule" ||
        main.gridProperties.rowCount !== 688 ||
        main.gridProperties.columnCount !== 96
      )
        throw new Problem(
          409,
          "The selected Texas schedule layout is incompatible.",
        );
      const byRosterId = meta.sheets.find(
          (sheet: any) => sheet.properties.sheetId === ROSTER_ID,
        ),
        byBindingId = meta.sheets.find(
          (sheet: any) => sheet.properties.sheetId === BINDINGS_ID,
        ),
        byRosterTitle = meta.sheets.find(
          (sheet: any) => sheet.properties.title === "Directory Roster",
        ),
        byBindingTitle = meta.sheets.find(
          (sheet: any) => sheet.properties.title === "Directory Bindings",
        );
      if (byRosterId && byBindingId) {
        if (
          byRosterId.properties.title !== "Directory Roster" ||
          byBindingId.properties.title !== "Directory Bindings" ||
          byRosterId.properties.hidden !== true ||
          byRosterId.properties.gridProperties.rowCount !== 5000 ||
          byRosterId.properties.gridProperties.columnCount !== 6 ||
          byBindingId.properties.hidden !== true ||
          byBindingId.properties.gridProperties.rowCount !== 181 ||
          byBindingId.properties.gridProperties.columnCount !== 6
        )
          throw new Problem(
            409,
            "The selected Texas helper layout is incompatible.",
          );
        return false;
      }
      if (byRosterId || byBindingId || byRosterTitle || byBindingTitle)
        throw new Problem(
          409,
          "The selected Texas helper layout is incomplete.",
        );
      if (
        roster.length >= 4999 ||
        roster.some(
          (row) =>
            row.length !== 6 ||
            row.some((value) => typeof value !== "string") ||
            [0, 1, 3, 4, 5].some((index) => !row[index]),
        )
      )
        throw new Problem(
          409,
          "The initial Texas directory roster is invalid.",
        );
      const rosterHeaders = [
          "Store ID",
          "Directory ID",
          "POS ID",
          "POS source",
          "Selection label",
          "POS name",
        ],
        bindingHeaders = [
          "Schedule row",
          "Store ID",
          "Selected name",
          "Directory ID",
          "POS employee ID",
          "Match status",
        ],
        bindingRows = [...mapping.rows, ...mapping.excludedMergedNonNameRows]
          .sort((a, b) => a.hourlyRow - b.hourlyRow)
          .map((entry, index) => {
            const row = index + 2;
            return [
              { userEnteredValue: { numberValue: entry.scheduleRow } },
              { userEnteredValue: { stringValue: entry.storeId } },
              {
                userEnteredValue: {
                  formulaValue: `=IF('Texas Schedule'!N${entry.scheduleRow}="","",'Texas Schedule'!N${entry.scheduleRow})`,
                },
              },
              {
                userEnteredValue: {
                  formulaValue: `=IFERROR(IF(C${row}="","",IF(COUNTIFS('Directory Roster'!$A$2:$A$5000,B${row},'Directory Roster'!$E$2:$E$5000,C${row})=1,INDEX(FILTER('Directory Roster'!$B$2:$B$5000,'Directory Roster'!$A$2:$A$5000=B${row},'Directory Roster'!$E$2:$E$5000=C${row}),1),"")),"")`,
                },
              },
              {
                userEnteredValue: {
                  formulaValue: `=IFERROR(IF(D${row}="","",INDEX(FILTER('Directory Roster'!$C$2:$C$5000,'Directory Roster'!$B$2:$B$5000=D${row}),1)),"")`,
                },
              },
              {
                userEnteredValue: {
                  formulaValue: `=IF(C${row}="","",IF(D${row}="","Select employee from dropdown","Matched"))`,
                },
              },
            ];
          });
      const requests = [
        {
          addSheet: {
            properties: {
              sheetId: ROSTER_ID,
              title: "Directory Roster",
              hidden: true,
              gridProperties: { rowCount: 5000, columnCount: 6 },
            },
          },
        },
        {
          addSheet: {
            properties: {
              sheetId: BINDINGS_ID,
              title: "Directory Bindings",
              hidden: true,
              gridProperties: { rowCount: 181, columnCount: 6 },
            },
          },
        },
        {
          updateCells: {
            range: {
              sheetId: ROSTER_ID,
              startRowIndex: 0,
              endRowIndex: roster.length + 1,
              startColumnIndex: 0,
              endColumnIndex: 6,
            },
            rows: [rosterHeaders, ...roster].map((row) => ({
              values: row.map((value) => ({
                userEnteredValue: { stringValue: value },
              })),
            })),
            fields: "userEnteredValue",
          },
        },
        {
          updateCells: {
            range: {
              sheetId: BINDINGS_ID,
              startRowIndex: 0,
              endRowIndex: bindingRows.length + 1,
              startColumnIndex: 0,
              endColumnIndex: 6,
            },
            rows: [
              {
                values: bindingHeaders.map((value) => ({
                  userEnteredValue: { stringValue: value },
                })),
              },
              ...bindingRows.map((values) => ({ values })),
            ],
            fields: "userEnteredValue",
          },
        },
      ];
      await json(
        await request(base + ":batchUpdate", {
          method: "POST",
          headers,
          body: JSON.stringify({ requests }),
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        }),
      );
      const after = await metadata();
      if (
        !after.sheets.some(
          (sheet: any) =>
            sheet.properties.sheetId === ROSTER_ID &&
            sheet.properties.title === "Directory Roster",
        ) ||
        !after.sheets.some(
          (sheet: any) =>
            sheet.properties.sheetId === BINDINGS_ID &&
            sheet.properties.title === "Directory Bindings",
        )
      )
        throw new Problem(409, "Texas helper preparation readback differed.");
      return true;
    },
    async read() {
      const meta = await metadata();
      for (const [id, title] of [
        [MAIN_ID, "Texas Schedule"],
        [ROSTER_ID, "Directory Roster"],
        [BINDINGS_ID, "Directory Bindings"],
      ])
        if (
          !meta.sheets.some(
            (s: any) =>
              s.properties.sheetId === id && s.properties.title === title,
          )
        )
          throw new Problem(409, "Draft sheet identity changed.");
      const rosterRows = Math.min(
        5000,
        meta.sheets.find((s: any) => s.properties.sheetId === ROSTER_ID)
          .properties.gridProperties.rowCount,
      );
      const query = new URLSearchParams({
        includeGridData: "true",
        fields:
          "spreadsheetId,sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))",
      });
      for (const range of [
        "'Texas Schedule'!N1:AU525",
        `'Directory Roster'!A1:F${rosterRows}`,
        "'Directory Bindings'!A1:F181",
      ])
        query.append("ranges", range);
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
      // The workbook ID is resolved server-side. Only exact scoped request shapes are accepted.
      for (const r of requests) {
        const x = r as any;
        if (Object.keys(r).length !== 1)
          throw new Problem(400, "Invalid draft write.");
        if (x.updateCells) {
          const g = x.updateCells.range;
          if (
            Object.keys(x.updateCells).some(
              (k) => !["range", "rows", "fields"].includes(k),
            ) ||
            x.updateCells.fields !== "userEnteredValue" ||
            !g ||
            !Number.isInteger(g.endRowIndex) ||
            g.endRowIndex <= g.startRowIndex ||
            !Array.isArray(x.updateCells.rows) ||
            x.updateCells.rows.length !== g.endRowIndex - g.startRowIndex ||
            x.updateCells.rows.some(
              (row: any) =>
                !Array.isArray(row.values) ||
                row.values.length !== g.endColumnIndex - g.startColumnIndex,
            ) ||
            !(
              (g.sheetId === ROSTER_ID &&
                g.startColumnIndex === 0 &&
                g.endColumnIndex === 6 &&
                g.startRowIndex === 0 &&
                g.endRowIndex <= 5000) ||
              (g.sheetId === BINDINGS_ID &&
                g.startColumnIndex === 3 &&
                g.endColumnIndex === 5 &&
                g.startRowIndex === 1 &&
                g.endRowIndex === 181)
            )
          )
            throw new Problem(
              400,
              "Write outside hidden draft metadata rejected.",
            );
        } else if (x.setDataValidation) {
          const g = x.setDataValidation.range;
          const map = (await import("../../schedule/mapping.texas.json"))
            .default;
          if (
            g.sheetId !== MAIN_ID ||
            g.startColumnIndex !== 13 ||
            g.endColumnIndex !== 14 ||
            g.endRowIndex !== g.startRowIndex + 1 ||
            !map.rows.some((m) => m.scheduleRow === g.endRowIndex)
          )
            throw new Problem(
              400,
              "Write outside mapped name validation rejected.",
            );
        } else if (x.updateSheetProperties) {
          const xprops = x.updateSheetProperties;
          if (
            xprops.properties.sheetId !== ROSTER_ID ||
            xprops.fields !== "gridProperties.rowCount" ||
            xprops.properties.gridProperties.rowCount !== 5000
          )
            throw new Problem(400, "Only hidden roster capacity can change.");
        } else throw new Problem(400, "Unsupported draft mutation.");
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
