import { createHash } from "node:crypto";
import mapping from "../../schedule/mapping.california.json";
import {
  cell,
  legacyScheduleName,
  scheduleNameKey,
  textValue,
  type DraftGrid,
  type ScheduleNameMatch,
  type ScheduleNameMiss,
} from "./draft-schedule";
import { displayName, Problem, type Employee } from "./model";
import {
  CALIFORNIA_DRAFT_ID,
  californiaDraftClient,
} from "./google-california-draft";

type MasterRow = { storeId: string; directoryId: string; label: string };

const scheduleRows = (store: (typeof mapping.stores)[number]) =>
  Array.from(
    { length: store.scheduleEndRow - store.scheduleStartRow + 1 },
    (_, index) => store.scheduleStartRow + index,
  );

const columnLetter = (column: number) => {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
};

function assertLayout(
  grid: DraftGrid,
  expectedWorkbookId = CALIFORNIA_DRAFT_ID,
) {
  if (grid.spreadsheetId !== expectedWorkbookId)
    throw new Problem(
      403,
      "The California schedule identity did not match the selected target.",
    );
  const schedule = grid.sheets.find(
      (sheet) => sheet.properties.sheetId === mapping.schedule.sheetId,
    )?.properties,
    master = grid.sheets.find(
      (sheet) => sheet.properties.sheetId === mapping.master.sheetId,
    )?.properties;
  if (
    schedule?.title !== mapping.schedule.sheet ||
    schedule.gridProperties.rowCount !== mapping.schedule.rowCount ||
    schedule.gridProperties.columnCount !== mapping.schedule.columnCount ||
    master?.title !== mapping.master.sheet ||
    master.gridProperties.rowCount !== mapping.master.rowCount ||
    master.gridProperties.columnCount !== mapping.master.columnCount
  )
    throw new Problem(
      409,
      "California draft layout changed; review mapping before syncing.",
    );
  for (const store of mapping.stores) {
    if (
      textValue(cell(grid, mapping.master.sheetId, 11, store.nameColumn)) !==
        store.sourceHeader ||
      textValue(cell(grid, mapping.master.sheetId, 13, store.nameColumn)) !==
        "Name" ||
      textValue(cell(grid, mapping.master.sheetId, 13, store.idColumn)) !== "ID"
    )
      throw new Problem(409, "California employee master headers changed.");
  }
}

export function californiaMasterFromGrid(
  grid: DraftGrid,
  expectedWorkbookId = CALIFORNIA_DRAFT_ID,
): MasterRow[] {
  assertLayout(grid, expectedWorkbookId);
  const rows: MasterRow[] = [];
  for (const store of mapping.stores) {
    let blankSeen = false;
    const labels = new Set<string>(),
      ids = new Set<string>();
    for (
      let row = mapping.master.startRow;
      row <= mapping.master.endRow;
      row++
    ) {
      const label = textValue(
          cell(grid, mapping.master.sheetId, row, store.nameColumn),
        ),
        directoryId = textValue(
          cell(grid, mapping.master.sheetId, row, store.idColumn),
        );
      if (!label && !directoryId) {
        blankSeen = true;
        continue;
      }
      if (!label || !directoryId || blankSeen)
        throw new Problem(
          409,
          "California employee master list is incomplete.",
        );
      const normalized = label.toLocaleLowerCase("en-US");
      if (labels.has(normalized))
        throw new Problem(409, "Duplicate California schedule label.");
      labels.add(normalized);
      ids.add(directoryId);
      rows.push({ storeId: store.storeId, directoryId, label });
    }
    if (ids.size > mapping.master.endRow - mapping.master.startRow + 1)
      throw new Problem(409, "California employee master capacity reached.");
  }
  return rows;
}

export function planCaliforniaDraftPreparation(
  grid: DraftGrid,
  employees: Employee[],
  workbookId = CALIFORNIA_DRAFT_ID,
) {
  assertLayout(grid, workbookId);
  let current: MasterRow[] | undefined;
  try {
    current = californiaMasterFromGrid(grid, workbookId);
  } catch {
    current = undefined;
  }
  if (
    current &&
    mapping.stores.every((store) =>
      current.some((row) => row.storeId === store.storeId),
    ) &&
    current.every((row) =>
      employees.some(
        (employee) =>
          employee.id === row.directoryId && employee.storeId === row.storeId,
      ),
    )
  )
    return { requests: [] as Record<string, unknown>[], prepared: false };

  const requests: Record<string, unknown>[] = [];
  for (const store of mapping.stores) {
    const selected = new Set(
        scheduleRows(store)
          .map((row) =>
            textValue(
              cell(
                grid,
                mapping.schedule.sheetId,
                row,
                mapping.schedule.nameColumn,
              ),
            ),
          )
          .filter(Boolean),
      ),
      candidates = employees
        .filter((employee) => employee.storeId === store.storeId)
        .sort((a, b) => displayName(a).localeCompare(displayName(b), "en-US")),
      claims = new Map<string, string>(),
      rows: MasterRow[] = [];
    for (const employee of candidates) {
      let label = displayName(employee),
        key = label.toLocaleLowerCase("en-US");
      if (claims.has(key) && claims.get(key) !== employee.id) {
        label = `${employee.firstName} ${employee.lastName}`;
        key = label.toLocaleLowerCase("en-US");
      }
      if (claims.has(key) && claims.get(key) !== employee.id)
        throw new Problem(
          409,
          `Two employees at ${store.storeId} need distinct preferred schedule names.`,
        );
      claims.set(key, employee.id);
      if (employee.status === "active" || selected.has(label))
        rows.push({ storeId: store.storeId, directoryId: employee.id, label });
    }
    const existingLength = Array.from(
      { length: mapping.master.endRow - mapping.master.startRow + 1 },
      (_, index) => mapping.master.startRow + index,
    ).reduce(
      (last, row) =>
        textValue(cell(grid, mapping.master.sheetId, row, store.nameColumn)) ||
        textValue(cell(grid, mapping.master.sheetId, row, store.idColumn))
          ? row - mapping.master.startRow + 1
          : last,
      0,
    );
    const writeLength = Math.max(existingLength, rows.length);
    if (
      !rows.length ||
      writeLength > mapping.master.endRow - mapping.master.startRow + 1
    )
      throw new Problem(409, "California employee master capacity reached.");
    requests.push({
      updateCells: {
        range: {
          sheetId: mapping.master.sheetId,
          startRowIndex: mapping.master.startRow - 1,
          endRowIndex: mapping.master.startRow - 1 + writeLength,
          startColumnIndex: store.nameColumn - 1,
          endColumnIndex: store.idColumn,
        },
        rows: Array.from({ length: writeLength }, (_, index) => {
          const row = rows[index];
          return {
            values: row
              ? [row.label, row.directoryId].map((value) => ({
                  userEnteredValue: { stringValue: value },
                }))
              : [{}, {}],
          };
        }),
        fields: "userEnteredValue",
      },
    });
  }
  return { requests, prepared: true };
}

export function californiaDraftFingerprint(
  grid: DraftGrid,
  workbookId = CALIFORNIA_DRAFT_ID,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        master: californiaMasterFromGrid(grid, workbookId),
        selections: mapping.stores.flatMap((store) =>
          scheduleRows(store).map((row) => [
            store.storeId,
            row,
            textValue(
              cell(
                grid,
                mapping.schedule.sheetId,
                row,
                mapping.schedule.nameColumn,
              ),
            ),
          ]),
        ),
      }),
    )
    .digest("hex");
}

export async function stableCaliforniaDraft(
  client: Awaited<ReturnType<typeof californiaDraftClient>>,
  workbookId = CALIFORNIA_DRAFT_ID,
) {
  const first = (await client.read()) as DraftGrid,
    second = (await client.read()) as DraftGrid;
  if (
    californiaDraftFingerprint(first, workbookId) !==
    californiaDraftFingerprint(second, workbookId)
  )
    throw new Problem(
      409,
      "California schedule changed during the read; retry after editing.",
    );
  return second;
}

export function planCaliforniaDraftSync(
  grid: DraftGrid,
  employees: Employee[],
  workbookId = CALIFORNIA_DRAFT_ID,
) {
  const old = californiaMasterFromGrid(grid, workbookId),
    byId = new Map(employees.map((employee) => [employee.id, employee])),
    requests: Record<string, unknown>[] = [],
    roster: MasterRow[] = [];
  let activeCount = 0;
  for (const previous of old) {
    const employee = byId.get(previous.directoryId);
    if (!employee || employee.storeId !== previous.storeId)
      throw new Problem(
        409,
        "Historical California directory identity is missing or changed store.",
      );
  }
  for (const store of mapping.stores) {
    const previous = old.filter((row) => row.storeId === store.storeId),
      previousByLabel = new Map(
        previous.map((row) => [row.label.toLocaleLowerCase("en-US"), row]),
      ),
      selected = new Set(
        scheduleRows(store)
          .map((row) =>
            textValue(
              cell(
                grid,
                mapping.schedule.sheetId,
                row,
                mapping.schedule.nameColumn,
              ),
            ),
          )
          .filter(Boolean),
      ),
      active = employees
        .filter(
          (employee) =>
            employee.storeId === store.storeId && employee.status === "active",
        )
        .sort((a, b) => displayName(a).localeCompare(displayName(b), "en-US")),
      storeRows: MasterRow[] = [],
      claims = new Map<string, string>();
    activeCount += active.length;
    for (const employee of active) {
      let label = displayName(employee);
      const occupied = (candidate: string) => {
        const key = candidate.toLocaleLowerCase("en-US"),
          claimed = claims.get(key) || previousByLabel.get(key)?.directoryId;
        return !!claimed && claimed !== employee.id;
      };
      if (occupied(label)) label = `${employee.firstName} ${employee.lastName}`;
      if (occupied(label))
        throw new Problem(
          409,
          `Two employees at ${store.storeId} need distinct preferred schedule names.`,
        );
      const existing = previous.find(
        (row) =>
          row.directoryId === employee.id &&
          row.label.toLocaleLowerCase("en-US") ===
            label.toLocaleLowerCase("en-US"),
      );
      const entry = {
        storeId: store.storeId,
        directoryId: employee.id,
        label: existing?.label || label,
      };
      storeRows.push(entry);
      claims.set(entry.label.toLocaleLowerCase("en-US"), employee.id);
    }
    for (const label of selected) {
      if (storeRows.some((row) => row.label === label)) continue;
      const existing = previousByLabel.get(label.toLocaleLowerCase("en-US"));
      if (existing) storeRows.push(existing);
    }
    storeRows.sort((a, b) => a.label.localeCompare(b.label, "en-US"));
    const capacity = mapping.master.endRow - mapping.master.startRow + 1;
    if (!storeRows.length || storeRows.length > capacity)
      throw new Problem(409, "California employee master capacity reached.");
    const oldLength = previous.length,
      writeLength = Math.max(oldLength, storeRows.length),
      writeRows = Array.from({ length: writeLength }, (_, index) => {
        const row = storeRows[index];
        return {
          values: row
            ? [row.label, row.directoryId].map((value) => ({
                userEnteredValue: { stringValue: value },
              }))
            : [{}, {}],
        };
      });
    if (
      JSON.stringify(previous) !==
      JSON.stringify(
        storeRows.map((row) => ({
          storeId: row.storeId,
          directoryId: row.directoryId,
          label: row.label,
        })),
      )
    )
      requests.push({
        updateCells: {
          range: {
            sheetId: mapping.master.sheetId,
            startRowIndex: mapping.master.startRow - 1,
            endRowIndex: mapping.master.startRow - 1 + writeLength,
            startColumnIndex: store.nameColumn - 1,
            endColumnIndex: store.idColumn,
          },
          rows: writeRows,
          fields: "userEnteredValue",
        },
      });
    const optionEnd = mapping.master.startRow + storeRows.length - 1;
    requests.push({
      setDataValidation: {
        range: {
          sheetId: mapping.schedule.sheetId,
          startRowIndex: store.scheduleStartRow - 1,
          endRowIndex: store.scheduleEndRow,
          startColumnIndex: mapping.schedule.nameColumn - 1,
          endColumnIndex: mapping.schedule.nameColumn,
        },
        rule: {
          condition: {
            type: "ONE_OF_RANGE",
            values: [
              {
                userEnteredValue: `='${mapping.master.sheet}'!$${columnLetter(store.nameColumn)}$${mapping.master.startRow}:$${columnLetter(store.nameColumn)}$${optionEnd}`,
              },
            ],
          },
          strict: true,
          showCustomUi: true,
        },
      },
    });
    roster.push(...storeRows);
  }
  const reconciliation = reconcileCaliforniaScheduleNames(
    grid,
    employees,
    roster,
  );
  for (const match of reconciliation.reconciled)
    requests.push({
      updateCells: {
        range: {
          sheetId: mapping.schedule.sheetId,
          startRowIndex: match.row - 1,
          endRowIndex: match.row,
          startColumnIndex: mapping.schedule.nameColumn - 1,
          endColumnIndex: mapping.schedule.nameColumn,
        },
        rows: [
          {
            values: [{ userEnteredValue: { stringValue: match.to } }],
          },
        ],
        fields: "userEnteredValue",
      },
    });
  return { requests, roster, active: activeCount, reconciliation };
}

export function reconcileCaliforniaScheduleNames(
  grid: DraftGrid,
  employees: Employee[],
  roster: MasterRow[],
) {
  const rosterIds = new Set(
      roster.map((row) => `${row.storeId}|${row.directoryId}`),
    ),
    labels = new Map(
      roster.map((row) => [`${row.storeId}|${row.directoryId}`, row.label]),
    ),
    candidates = new Map<string, Map<string, string>>(),
    add = (
      storeId: string,
      value: string,
      employeeId: string,
      label: string,
    ) => {
      const key = scheduleNameKey(value);
      if (!key) return;
      const scopedKey = `${storeId}|${key}`;
      let matches = candidates.get(scopedKey);
      if (!matches) candidates.set(scopedKey, (matches = new Map()));
      matches.set(employeeId, label);
    };
  for (const employee of employees) {
    const scopedId = `${employee.storeId}|${employee.id}`;
    if (!rosterIds.has(scopedId)) continue;
    const label = labels.get(scopedId)!;
    const sourceNames = [
      label,
      displayName(employee),
      employee.firstName,
      `${employee.firstName} ${employee.lastName}`,
      `${employee.lastName}, ${employee.firstName}`,
      employee.posName,
      employee.observedPosName || "",
      ...employee.aliases,
    ];
    for (const name of [employee.posName, employee.observedPosName || ""])
      if (name.trim()) sourceNames.push(name.trim().split(/\s+/)[0]);
    for (const name of sourceNames)
      add(employee.storeId, name, employee.id, label);
  }

  const validLabels = new Set(
      roster.map((row) => `${row.storeId}|${row.label}`),
    ),
    reconciled: ScheduleNameMatch[] = [],
    unmatched: ScheduleNameMiss[] = [];
  for (const store of mapping.stores)
    for (const row of scheduleRows(store)) {
      const selected = textValue(
        cell(grid, mapping.schedule.sheetId, row, mapping.schedule.nameColumn),
      ).trim();
      if (!selected || validLabels.has(`${store.storeId}|${selected}`))
        continue;
      const matches = new Map<string, string>();
      for (const key of new Set([
        scheduleNameKey(selected),
        scheduleNameKey(legacyScheduleName(selected)),
      ]))
        for (const [employeeId, label] of candidates.get(
          `${store.storeId}|${key}`,
        ) || [])
          matches.set(employeeId, label);
      const labelsFound = [...new Set(matches.values())].sort((a, b) =>
        a.localeCompare(b, "en-US"),
      );
      if (matches.size === 1)
        reconciled.push({
          cell: `R${row}`,
          row,
          storeId: store.storeId,
          from: selected,
          to: labelsFound[0],
        });
      else
        unmatched.push({
          cell: `R${row}`,
          row,
          storeId: store.storeId,
          value: selected,
          reason: matches.size ? "ambiguous" : "no-match",
          candidates: labelsFound,
        });
    }
  return { reconciled, unmatched };
}

export function assertCaliforniaDraftReadback(
  grid: DraftGrid,
  expected: MasterRow[],
  workbookId = CALIFORNIA_DRAFT_ID,
  reconciliation: {
    reconciled: ScheduleNameMatch[];
    unmatched: ScheduleNameMiss[];
  } = { reconciled: [], unmatched: [] },
) {
  const actual = californiaMasterFromGrid(grid, workbookId);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Problem(409, "California employee master readback differed.");
  const unmatched = new Map(
    reconciliation.unmatched.map((miss) => [miss.cell, miss.value]),
  );
  for (const store of mapping.stores) {
    const options = new Set(
      actual
        .filter((row) => row.storeId === store.storeId)
        .map((row) => row.label),
    );
    const end = mapping.master.startRow + options.size - 1,
      formula = `='${mapping.master.sheet}'!$${columnLetter(store.nameColumn)}$${mapping.master.startRow}:$${columnLetter(store.nameColumn)}$${end}`;
    for (const row of scheduleRows(store)) {
      const target = cell(
          grid,
          mapping.schedule.sheetId,
          row,
          mapping.schedule.nameColumn,
        ),
        validation = target.dataValidation;
      if (
        (textValue(target) &&
          !options.has(textValue(target)) &&
          unmatched.get(`R${row}`) !== textValue(target)) ||
        validation?.condition?.type !== "ONE_OF_RANGE" ||
        validation.condition.values?.[0]?.userEnteredValue !== formula ||
        validation.strict !== true
      )
        throw new Problem(409, "California dropdown readback differed.");
    }
  }
  for (const match of reconciliation.reconciled)
    if (
      textValue(
        cell(
          grid,
          mapping.schedule.sheetId,
          match.row,
          mapping.schedule.nameColumn,
        ),
      ) !== match.to
    )
      throw new Problem(
        409,
        "California name reconciliation readback differed.",
      );
}
