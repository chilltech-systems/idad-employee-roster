import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import mapping from "../../schedule/mapping.texas.json";
import {
  displayName,
  resolvedPosIdentity,
  Problem,
  type Employee,
  type State,
  type Account,
} from "./model";
import {
  DRAFT_ID,
  MAIN_ID,
  ROSTER_ID,
  BINDINGS_ID,
  draftClient,
} from "./google-draft";
import { exportShifts, replaceSnapshot, type ShiftInput } from "./shifts";
export type GridCell = {
  userEnteredValue?: {
    stringValue?: string;
    numberValue?: number;
    formulaValue?: string;
  };
  effectiveValue?: {
    stringValue?: string;
    numberValue?: number;
    errorValue?: unknown;
  };
  formattedValue?: string;
  dataValidation?: {
    condition?: {
      type?: string;
      values?: { userEnteredValue?: string }[];
    };
    strict?: boolean;
    showCustomUi?: boolean;
  };
};
export type DraftGrid = {
  spreadsheetId: string;
  sheets: {
    properties: {
      sheetId: number;
      title: string;
      gridProperties: { rowCount: number; columnCount: number };
    };
    data?: {
      startRow?: number;
      startColumn?: number;
      rowData?: { values?: GridCell[] }[];
    }[];
  }[];
};
export function cell(
  g: DraftGrid,
  sheetId: number,
  row: number,
  col: number,
): GridCell {
  const s = g.sheets.find((s) => s.properties.sheetId === sheetId);
  if (
    !s ||
    s.properties.gridProperties.rowCount < row ||
    s.properties.gridProperties.columnCount < col
  )
    throw new Problem(409, "Draft layout changed; review mapping.");
  for (const d of s.data || []) {
    const r = row - 1 - (d.startRow || 0),
      c = col - 1 - (d.startColumn || 0);
    if (r >= 0 && c >= 0 && d.rowData?.[r]?.values?.[c])
      return d.rowData[r].values![c];
  }
  return {};
}
export const textValue = (c: GridCell) =>
  c.effectiveValue?.stringValue ?? c.userEnteredValue?.stringValue ?? "";
export function rosterFromGrid(g: DraftGrid): string[][] {
  if (g.spreadsheetId !== DRAFT_ID)
    throw new Problem(403, "Only the copied draft is allowed.");
  const main = g.sheets.find(
    (s) => s.properties.sheetId === MAIN_ID,
  )?.properties;
  if (
    main?.title !== "Texas Schedule" ||
    main.gridProperties.rowCount !== 688 ||
    main.gridProperties.columnCount !== 96
  )
    throw new Problem(
      409,
      "Draft layout changed; review mapping before syncing or exporting.",
    );
  const headers = [
    "Store ID",
    "Directory ID",
    "POS ID",
    "POS source",
    "Selection label",
    "POS name",
  ];
  if (headers.some((h, i) => textValue(cell(g, ROSTER_ID, 1, i + 1)) !== h))
    throw new Problem(409, "Hidden roster columns changed.");
  const n = g.sheets.find((s) => s.properties.sheetId === ROSTER_ID)!.properties
    .gridProperties.rowCount;
  const rows: string[][] = [];
  for (let row = 2; row <= Math.min(n, 5000); row++) {
    const values = Array.from({ length: 6 }, (_, i) =>
      textValue(cell(g, ROSTER_ID, row, i + 1)),
    );
    if (values.every((v) => !v)) continue;
    if ([0, 1, 3, 4, 5].some((i) => !values[i]))
      throw new Problem(409, "Incomplete hidden roster entry.");
    rows.push(values);
  }
  if (rows.length >= 4999)
    throw new Problem(409, "Roster alias capacity reached.");
  const keys = rows.map((r) => r[0] + "|" + r[4].toLocaleLowerCase("en-US"));
  if (new Set(keys).size !== keys.length)
    throw new Problem(409, "Duplicate schedule labels require review.");
  return rows;
}
export function draftFingerprint(g: DraftGrid) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        week: cell(g, MAIN_ID, 1, 16).effectiveValue,
        roster: rosterFromGrid(g),
        rows: mapping.rows.map((m) => [
          m.storeId,
          m.scheduleRow,
          textValue(cell(g, MAIN_ID, m.scheduleRow, 14)),
          ...Array.from({ length: 7 }, (_, i) => [
            cell(g, MAIN_ID, m.scheduleRow, 16 + i * 5).effectiveValue,
            cell(g, MAIN_ID, m.scheduleRow, 17 + i * 5).effectiveValue,
          ]),
        ]),
      }),
    )
    .digest("hex");
}
export async function stableDraft(
  client: Awaited<ReturnType<typeof draftClient>>,
) {
  const first = (await client.read()) as DraftGrid,
    second = (await client.read()) as DraftGrid;
  if (draftFingerprint(first) !== draftFingerprint(second))
    throw new Problem(
      409,
      "Schedule changed during the read; retry after editing.",
    );
  return second;
}
export function planDraftSync(g: DraftGrid, employees: Employee[]) {
  const old = rosterFromGrid(g),
    rows = old.map((r) => [...r]),
    labels = new Map<string, string>();
  const claims = new Map(
    rows.map((r) => [r[0] + "|" + r[4].toLocaleLowerCase("en-US"), r[1]]),
  );
  const scoped = employees.filter((e) =>
    mapping.rows.some((m) => m.storeId === e.storeId),
  );
  const byId = new Map(scoped.map((e) => [e.id, e]));
  for (const r of rows) {
    const e = byId.get(r[1]);
    if (!e || e.storeId !== r[0] || e.posSource !== r[3])
      throw new Problem(
        409,
        "Historical roster identity missing or changed store; review required.",
      );
    r[2] = resolvedPosIdentity(e, employees).posEmployeeId;
    r[5] = e.posName;
  }
  for (const e of scoped.filter((e) => e.status === "active")) {
    const identity = resolvedPosIdentity(e, employees);
    let label = displayName(e);
    const occupied = (name: string) =>
      claims.has(e.storeId + "|" + name.toLocaleLowerCase("en-US")) &&
      claims.get(e.storeId + "|" + name.toLocaleLowerCase("en-US")) !== e.id;
    if (occupied(label)) label = `${e.firstName} ${e.lastName}`;
    const sameAlias = rows.find(
      (r) =>
        r[0] === e.storeId &&
        r[1] === e.id &&
        r[4].toLocaleLowerCase("en-US") === label.toLocaleLowerCase("en-US"),
    );
    if (sameAlias) label = sameAlias[4];
    if (occupied(label))
      throw new Problem(
        409,
        `Two employees at ${e.storeId} need distinct preferred schedule names.`,
      );
    if (
      !rows.some((r) => r[0] === e.storeId && r[1] === e.id && r[4] === label)
    ) {
      // A new alias must not silently claim a pre-existing unbound typed name.
      if (
        mapping.rows.some(
          (m) =>
            m.storeId === e.storeId &&
            textValue(cell(g, MAIN_ID, m.scheduleRow, 14)) === label,
        ) &&
        !old.some((r) => r[0] === e.storeId && r[4] === label)
      )
        throw new Problem(
          409,
          `Clear the unbound matching name in ${e.storeId}, sync, then explicitly reselect the employee.`,
        );
      rows.push([
        e.storeId,
        e.id,
        identity.posEmployeeId,
        e.posSource,
        label,
        e.posName,
      ]);
      claims.set(e.storeId + "|" + label.toLocaleLowerCase("en-US"), e.id);
    }
    labels.set(e.id, label);
  }
  if (rows.length >= 4999)
    throw new Problem(409, "Roster alias capacity reached.");
  const requests: Record<string, unknown>[] = [];
  const gridRows = g.sheets.find((s) => s.properties.sheetId === ROSTER_ID)!
    .properties.gridProperties.rowCount;
  if (gridRows < 5000)
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: ROSTER_ID, gridProperties: { rowCount: 5000 } },
        fields: "gridProperties.rowCount",
      },
    });
  const all = [
    [
      "Store ID",
      "Directory ID",
      "POS ID",
      "POS source",
      "Selection label",
      "POS name",
    ],
    ...rows,
  ];
  if (JSON.stringify(old) !== JSON.stringify(rows))
    requests.push({
      updateCells: {
        range: {
          sheetId: ROSTER_ID,
          startRowIndex: 0,
          endRowIndex: all.length,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        rows: all.map((r) => ({
          values: r.map((v) => ({ userEnteredValue: { stringValue: v } })),
        })),
        fields: "userEnteredValue",
      },
    });
  for (const m of mapping.rows) {
    const options = scoped
      .filter((e) => e.storeId === m.storeId && e.status === "active")
      .map((e) => labels.get(e.id)!);
    const selected = textValue(cell(g, MAIN_ID, m.scheduleRow, 14));
    if (
      selected &&
      rows.some((r) => r[0] === m.storeId && r[4] === selected) &&
      !options.includes(selected)
    )
      options.push(selected);
    // Empty lists allow no new nonblank entry, without clearing the selected identity.
    requests.push({
      setDataValidation: {
        range: {
          sheetId: MAIN_ID,
          startRowIndex: m.scheduleRow - 1,
          endRowIndex: m.scheduleRow,
          startColumnIndex: 13,
          endColumnIndex: 14,
        },
        rule: options.length
          ? {
              condition: {
                type: "ONE_OF_LIST",
                values: options.map((userEnteredValue) => ({
                  userEnteredValue,
                })),
              },
              strict: true,
              showCustomUi: true,
            }
          : {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: `=N${m.scheduleRow}=""` }],
              },
              strict: true,
            },
      },
    });
  }
  // Expand only existing hidden lookup formula bounds; never write selected names or shifts.
  const formulas = [];
  for (let r = 2; r <= 181; r++)
    formulas.push({
      values: [4, 5].map((c) => {
        const f = cell(g, BINDINGS_ID, r, c).userEnteredValue?.formulaValue;
        if (!f) throw new Problem(409, "Hidden bindings layout changed.");
        const expanded = f.replace(
          /\$([A-F])\$91/g,
          (_match, column) => "$" + column + "$5000",
        );
        // COUNTIFS and FILTER can disagree on typed-name casing. An unresolved
        // label stays unbound and visible in the match-status column, never an ID guess.
        const guarded = expanded.startsWith("=IFERROR(")
          ? expanded
          : "=IFERROR(" + expanded.slice(1) + ',"")';
        return { userEnteredValue: { formulaValue: guarded } };
      }),
    });
  if (
    formulas.some((r, i) =>
      r.values.some(
        (c, j) =>
          c.userEnteredValue.formulaValue !==
          cell(g, BINDINGS_ID, i + 2, j + 4).userEnteredValue?.formulaValue,
      ),
    )
  )
    requests.push({
      updateCells: {
        range: {
          sheetId: BINDINGS_ID,
          startRowIndex: 1,
          endRowIndex: 181,
          startColumnIndex: 3,
          endColumnIndex: 5,
        },
        rows: formulas,
        fields: "userEnteredValue",
      },
    });
  return { requests, roster: rows, active: labels.size };
}
function time(c: GridCell) {
  const n = c.effectiveValue?.numberValue;
  if (n !== undefined) {
    if (n < 0 || n >= 1 || Math.abs(n * 1440 - Math.round(n * 1440)) > 0.001)
      return String(n);
    const minutes = Math.round(n * 1440);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (c.effectiveValue?.errorValue) return "#CELL_ERROR";
  const s = textValue(c).trim();
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(s);
  if (!m) return s;
  let h = Number(m[1]);
  if (m[3]) {
    if (h < 1 || h > 12) return s;
    h = (h % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  }
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
export type Exclusion = { row: number; reason: string };
export function extractDraft(
  g: DraftGrid,
  storeId: string,
  revision: number,
  exclusions: Exclusion[] = [],
  overnight: { row: number; day: number }[] = [],
) {
  const mapped = mapping.rows.filter((m) => m.storeId === storeId);
  if (!mapped.length) throw new Problem(400, "Store is not mapped.");
  if (
    new Set(exclusions.map((e) => e.row)).size !== exclusions.length ||
    exclusions.some(
      (e) =>
        !mapped.some((m) => m.scheduleRow === e.row) ||
        e.reason.trim().length < 5,
    )
  )
    throw new Problem(400, "Every excluded row needs a mapped row and reason.");
  if (
    overnight.some(
      (e) =>
        !mapped.some((m) => m.scheduleRow === e.row) ||
        !Number.isInteger(e.day) ||
        e.day < 0 ||
        e.day > 6,
    )
  )
    throw new Problem(400, "Invalid overnight selection.");
  const serial = cell(g, MAIN_ID, 1, 16).effectiveValue?.numberValue;
  if (serial === undefined || !Number.isInteger(serial))
    throw new Problem(409, "Schedule P1 must contain a Sunday date.");
  const week = DateTime.fromISO("1899-12-30", { zone: "UTC" }).plus({
    days: serial,
  });
  if (week.weekday !== 7)
    throw new Problem(409, "Schedule week must start Sunday.");
  const roster = rosterFromGrid(g),
    cells: ShiftInput["cells"] = [],
    omitted: { row: number; date: string; reason: string }[] = [];
  for (const m of mapped) {
    const selected = textValue(cell(g, MAIN_ID, m.scheduleRow, 14));
    const matches = roster.filter((r) => r[0] === storeId && r[4] === selected);
    const id = selected && matches.length === 1 ? matches[0][1] : "";
    for (let day = 0; day < 7; day++) {
      const start = time(cell(g, MAIN_ID, m.scheduleRow, 16 + day * 5)),
        end = time(cell(g, MAIN_ID, m.scheduleRow, 17 + day * 5));
      const date = week.plus({ days: day }).toISODate()!;
      const exclude = exclusions.find((e) => e.row === m.scheduleRow);
      if (exclude && (start || end)) {
        omitted.push({ row: m.scheduleRow, date, reason: exclude.reason });
        continue;
      }
      cells.push({
        sheet: "Texas Schedule",
        row: m.scheduleRow,
        slot: "shift",
        storeId,
        directoryId: id,
        businessDate: date,
        start,
        end,
        overnight: overnight.some(
          (e) => e.row === m.scheduleRow && e.day === day,
        ),
      });
    }
  }
  return {
    input: {
      workbookId: DRAFT_ID,
      weekStart: week.toISODate()!,
      revision,
      cells,
    },
    omitted,
  };
}
export type DraftExport = {
  scope: "complete-store" | "explicit-exclusions";
  storeId: string;
  fingerprint: string;
  at: string;
  overnight: { row: number; day: number }[];
  omitted: { row: number; date: string; reason: string }[];
  snapshot: ReturnType<typeof exportShifts>;
};
export function validateDraftExport(
  g: DraftGrid,
  employees: Employee[],
  storeId: string,
  previous: DraftExport | undefined,
  exclusions: Exclusion[] = [],
  overnight: { row: number; day: number }[] = [],
) {
  const extracted = extractDraft(g, storeId, 1, exclusions, overnight),
    fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          extracted,
          employees: employees
            .filter((e) => e.storeId === storeId)
            .map((e) => {
              const identity = resolvedPosIdentity(e, employees);
              return {
                id: e.id,
                personId: e.personId,
                posIdentityPending: identity.posIdentityPending,
                storeId: e.storeId,
                posSource: e.posSource,
                posEmployeeId: identity.posEmployeeId,
                posName: e.posName,
                displayName: displayName(e),
                verification: e.verification,
              };
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
        }),
      )
      .digest("hex");
  const same = previous?.fingerprint === fingerprint;
  const revision = same
    ? previous.snapshot.revision
    : (previous?.snapshot.revision || 0) + 1;
  const snapshot = exportShifts({ ...extracted.input, revision }, employees);
  for (const issue of snapshot.exceptions) {
    const date = extracted.input.cells[issue.sourceIndex]?.businessDate;
    if (date) issue.reason = date + ": " + issue.reason;
  }
  if (
    previous?.snapshot.ready &&
    snapshot.ready &&
    previous.snapshot.weekStart === snapshot.weekStart
  )
    replaceSnapshot(previous.snapshot, snapshot);
  return {
    scope: extracted.omitted.length
      ? ("explicit-exclusions" as const)
      : ("complete-store" as const),
    storeId,
    fingerprint,
    at: same ? previous.at : new Date().toISOString(),
    overnight: overnight.map((entry) => ({ ...entry })),
    omitted: extracted.omitted,
    snapshot,
  };
}
export function draftExportKey(storeId: string, week: string, scoped = false) {
  return [DRAFT_ID, storeId, week, ...(scoped ? ["scoped"] : [])].join(":");
}
export function recordDraftExport(
  s: State,
  result: DraftExport,
  actor?: Account,
) {
  const key = draftExportKey(
    result.storeId,
    result.snapshot.weekStart,
    result.scope === "explicit-exclusions",
  );
  s.sync.draftExports ??= {};
  if (
    !s.sync.draftExports[key] &&
    Object.keys(s.sync.draftExports).length >= 64
  )
    throw new Problem(
      409,
      "Local export archive needs review before adding another week.",
    );
  // Invalid attempts never replace an accepted snapshot. Their response still includes every exception.
  if (
    result.snapshot.ready &&
    s.sync.draftExports[key]?.fingerprint !== result.fingerprint
  ) {
    s.sync.draftExports[key] = result;
    if (actor)
      s.audit.push({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actor.id,
        action: "schedule.draft-export",
        storeId: result.storeId,
        reason: `Week ${result.snapshot.weekStart}, revision ${result.snapshot.revision}, ${result.snapshot.valid} shifts, ${result.omitted.length} explicit exclusions`,
      });
  }
  return result;
}
