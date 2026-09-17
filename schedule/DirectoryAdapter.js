/**
 * Prepared for a separately copied Texas workbook. Not installed or activated.
 * No network requests, posting, or writes to any other workbook exist here.
 * Properties: PORTAL_DRAFT_ID, PORTAL_MAPPING_JSON, PORTAL_WEEK_START.
 * Mapping must be reviewed from the complete copied workbook before activation.
 */
function directoryDraft_() {
  const book = SpreadsheetApp.getActive();
  const approved =
    PropertiesService.getScriptProperties().getProperty("PORTAL_DRAFT_ID");
  if (
    !approved ||
    book.getId() !== approved ||
    approved === "1EiuMU83LtVXvevJDVLhQRKoDpN4n7NcSMkQrmkxyKWs"
  ) {
    throw new Error(
      "Only the explicitly configured draft copy can be changed.",
    );
  }
  return book;
}
function directoryMapping_() {
  const mapping = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(
      "PORTAL_MAPPING_JSON",
    ) || "[]",
  );
  if (!Array.isArray(mapping) || !mapping.length)
    throw new Error("Review and configure exact employee blocks first.");
  const covered = new Set();
  mapping.forEach(function (block) {
    if (
      !block.sheet ||
      !block.storeId ||
      !Array.isArray(block.rows) ||
      !block.rows.length ||
      !Number.isInteger(block.nameColumn) ||
      !Array.isArray(block.days) ||
      block.days.length !== 7
    )
      throw new Error("Incomplete block mapping.");
    block.rows.forEach(function (row) {
      if (!Number.isInteger(row) || row < 1)
        throw new Error("Invalid employee row.");
      const key = block.sheet + ":" + row;
      if (covered.has(key))
        throw new Error("Employee row appears in multiple blocks.");
      covered.add(key);
    });
    block.days.forEach(function (day, i) {
      if (day.offset !== i || !Array.isArray(day.slots) || !day.slots.length)
        throw new Error("Map every day Sunday through Saturday.");
      day.slots.forEach(function (slot) {
        if (
          !slot.key ||
          !Number.isInteger(slot.startColumn) ||
          !Number.isInteger(slot.endColumn)
        )
          throw new Error("Invalid shift slot mapping.");
      });
    });
  });
  return mapping;
}
function directoryTab_(book, name) {
  return book.getSheetByName(name) || book.insertSheet(name);
}
function directoryMenu() {
  directoryDraft_();
  SpreadsheetApp.getUi()
    .createMenu("Employee Directory")
    .addItem("Import roster JSON", "directoryImportRoster")
    .addItem("Prepare shift input", "directoryPrepareShiftInput")
    .addToUi();
}
function directoryImportRoster() {
  const book = directoryDraft_();
  const mapping = directoryMapping_();
  const answer = SpreadsheetApp.getUi().prompt(
    "Import roster",
    "Paste a store-scoped extended JSON roster exported from the portal.",
    SpreadsheetApp.getUi().ButtonSet.OK_CANCEL,
  );
  if (answer.getSelectedButton() !== SpreadsheetApp.getUi().Button.OK) return;
  const roster = JSON.parse(answer.getResponseText());
  if (
    roster.version !== 1 ||
    !roster.storeId ||
    !Array.isArray(roster.employees) ||
    !roster.employees.length
  )
    throw new Error("Empty or invalid roster; previous roster retained.");
  if (!mapping.some((b) => b.storeId === roster.storeId))
    throw new Error("Roster store is not mapped in this draft.");
  const ids = new Set(),
    labels = new Set();
  roster.employees.forEach(function (e) {
    if (
      e.storeId !== roster.storeId ||
      !e.id ||
      !e.posEmployeeId ||
      !e.dropdownLabel ||
      e.status !== "active" ||
      ids.has(e.id) ||
      labels.has(e.dropdownLabel)
    )
      throw new Error("Conflicting, incomplete or duplicate roster entries.");
    ids.add(e.id);
    labels.add(e.dropdownLabel);
  });
  const tab = directoryTab_(book, "Directory Roster");
  const old =
    tab.getLastRow() > 1
      ? tab.getRange(2, 1, tab.getLastRow() - 1, 6).getDisplayValues()
      : [];
  const retained = old.filter((r) => r[0] !== roster.storeId);
  const values = retained.concat(
    roster.employees.map((e) => [
      e.storeId,
      e.id,
      e.posEmployeeId,
      e.posSource,
      e.dropdownLabel,
      e.posName,
    ]),
  );
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    tab.clearContents();
    tab
      .getRange(1, 1, 1, 6)
      .setValues([
        [
          "Store ID",
          "Directory ID",
          "POS ID",
          "POS source",
          "Selection label",
          "POS name",
        ],
      ]);
    tab.getRange(2, 1, values.length, 6).setNumberFormat("@").setValues(values);
    const labelById = new Map(
      roster.employees.map((e) => [e.id, e.dropdownLabel]),
    );
    const bindings = directoryReadBindings_(book);
    mapping
      .filter((b) => b.storeId === roster.storeId)
      .forEach(function (block) {
        const sheet = book.getSheetByName(block.sheet);
        if (!sheet) throw new Error("Mapped tab is missing.");
        block.rows.forEach(function (row) {
          const bound = bindings.find(
            (b) =>
              b[0] === block.sheet &&
              Number(b[1]) === row &&
              b[2] === block.storeId,
          );
          const choices = [...labels];
          // Preserve already selected identities, even when absent from the new active roster.
          if (bound && bound[3]) {
            const label = labelById.get(bound[3]) || bound[4];
            if (!choices.includes(label)) choices.push(label);
            sheet.getRange(row, block.nameColumn).setValue(label);
            bound[4] = label;
          }
          sheet
            .getRange(row, block.nameColumn)
            .setDataValidation(
              SpreadsheetApp.newDataValidation()
                .requireValueInList(choices, true)
                .setAllowInvalid(false)
                .build(),
            );
        });
      });
    directoryWriteBindings_(book, bindings);
  } finally {
    lock.releaseLock();
  }
}
function directoryReadBindings_(book) {
  const tab = book.getSheetByName("Directory Bindings");
  return tab && tab.getLastRow() > 1
    ? tab.getRange(2, 1, tab.getLastRow() - 1, 5).getDisplayValues()
    : [];
}
function directoryWriteBindings_(book, rows) {
  const tab = directoryTab_(book, "Directory Bindings");
  tab.clearContents();
  tab
    .getRange(1, 1, 1, 5)
    .setValues([
      ["Sheet", "Row", "Store ID", "Directory ID", "Selection label"],
    ]);
  if (rows.length)
    tab.getRange(2, 1, rows.length, 5).setNumberFormat("@").setValues(rows);
  tab.hideSheet();
  // Install with an owner-run edit trigger and protect this sheet before a pilot.
  // Protection editors must be explicitly reviewed; code never changes access grants.
}
function directoryOnEdit(event) {
  const book = directoryDraft_();
  if (!event || !event.range) return;
  const mapping = directoryMapping_();
  const edited = event.range;
  const relevant = mapping.filter(
    (b) =>
      b.sheet === edited.getSheet().getName() &&
      b.nameColumn >= edited.getColumn() &&
      b.nameColumn <= edited.getLastColumn(),
  );
  if (!relevant.length) return;
  const tab = book.getSheetByName("Directory Roster");
  if (!tab || tab.getLastRow() < 2)
    throw new Error("Import the directory roster first.");
  const roster = tab.getRange(2, 1, tab.getLastRow() - 1, 6).getDisplayValues();
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    let bindings = directoryReadBindings_(book);
    relevant.forEach(function (block) {
      block.rows
        .filter((r) => r >= edited.getRow() && r <= edited.getLastRow())
        .forEach(function (row) {
          const label = edited
            .getSheet()
            .getRange(row, block.nameColumn)
            .getDisplayValue();
          const old = bindings.find(
            (b) =>
              b[0] === block.sheet &&
              Number(b[1]) === row &&
              b[2] === block.storeId,
          );
          if (old && old[4] === label) return;
          bindings = bindings.filter(
            (b) =>
              !(
                b[0] === block.sheet &&
                Number(b[1]) === row &&
                b[2] === block.storeId
              ),
          );
          if (!label) return;
          const matches = roster.filter(
            (r) => r[0] === block.storeId && r[4] === label,
          );
          // Selection from a unique ID-backed roster label is intentional; free-name fuzzy matching is forbidden.
          if (matches.length !== 1)
            throw new Error("Selection is not a unique directory entry.");
          bindings.push([
            block.sheet,
            String(row),
            block.storeId,
            matches[0][1],
            label,
          ]);
        });
    });
    directoryWriteBindings_(book, bindings);
  } finally {
    lock.releaseLock();
  }
}
function directoryTime_(value) {
  const text = String(value).trim();
  if (!text) return "";
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(text);
  if (!match) return text; // Validator will report the original unsupported value as an exception.
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) {
    if (hour < 1 || hour > 12) return text;
    hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return text;
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}
function directoryPrepareShiftInput() {
  const book = directoryDraft_(),
    mapping = directoryMapping_(),
    props = PropertiesService.getScriptProperties();
  const week = props.getProperty("PORTAL_WEEK_START");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(week || "") ||
    new Date(week + "T12:00:00Z").getUTCDay() !== 0
  )
    throw new Error(
      "Set an explicit Sunday PORTAL_WEEK_START in YYYY-MM-DD format.",
    );
  const bindings = directoryReadBindings_(book),
    cells = [];
  mapping.forEach(function (block) {
    const sheet = book.getSheetByName(block.sheet);
    if (!sheet) throw new Error("Mapped sheet is missing.");
    block.rows.forEach(function (row) {
      const binding = bindings.find(
        (b) =>
          b[0] === block.sheet &&
          Number(b[1]) === row &&
          b[2] === block.storeId,
      );
      const selected = sheet.getRange(row, block.nameColumn).getDisplayValue();
      block.days.forEach(function (day) {
        const date = new Date(week + "T12:00:00Z");
        date.setUTCDate(date.getUTCDate() + day.offset);
        day.slots.forEach(function (slot) {
          cells.push({
            sheet: block.sheet,
            row: row,
            slot: slot.key,
            storeId: block.storeId,
            directoryId: binding && binding[4] === selected ? binding[3] : "",
            businessDate: date.toISOString().slice(0, 10),
            start: directoryTime_(
              sheet.getRange(row, slot.startColumn).getDisplayValue(),
            ),
            end: directoryTime_(
              sheet.getRange(row, slot.endColumn).getDisplayValue(),
            ),
            overnight: slot.overnightColumn
              ? sheet.getRange(row, slot.overnightColumn).getValue() === true
              : false,
          });
        });
      });
    });
  });
  const revision = Number(props.getProperty("PORTAL_EXPORT_REVISION") || 0) + 1;
  const payload = {
    workbookId: book.getId(),
    weekStart: week,
    revision: revision,
    cells: cells,
  };
  const json = JSON.stringify(payload);
  if (json.length > 45000)
    throw new Error(
      "Shift input exceeds a safe cell size; use smaller reviewed store blocks.",
    );
  const tab = directoryTab_(book, "Employee Shift Input");
  tab.clearContents();
  tab
    .getRange("A1")
    .setValue(
      "Unvalidated input — validate through the portal before reporting",
    );
  tab.getRange("A2").setNumberFormat("@").setValue(json);
  props.setProperty("PORTAL_EXPORT_REVISION", String(revision));
  SpreadsheetApp.getUi().alert(
    "Shift input prepared. Every mapped populated slot is included. Validate the JSON through the local exporter; this step did not publish a schedule or report.",
  );
}
