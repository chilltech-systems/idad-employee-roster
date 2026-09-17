import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync("schedule/DirectoryAdapter.js", "utf8");
test("draft script refuses the original workbook even if mistakenly allowlisted", () => {
  const id = "1EiuMU83LtVXvevJDVLhQRKoDpN4n7NcSMkQrmkxyKWs";
  const context = vm.createContext({
    SpreadsheetApp: { getActive: () => ({ getId: () => id }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => id }),
    },
  });
  vm.runInContext(source, context);
  assert.throws(
    () => vm.runInContext("directoryDraft_()", context),
    /draft copy/,
  );
});
test("draft adapter keeps unsupported time text visible and normalizes AM/PM", () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('directoryTime_("9:30 PM")', context), "21:30");
  assert.equal(vm.runInContext('directoryTime_("12:00 AM")', context), "00:00");
  assert.equal(vm.runInContext('directoryTime_("OFF")', context), "OFF");
  assert.equal(vm.runInContext('directoryTime_("")', context), "");
});
test("adapter requires reviewed explicit mapping and makes no outbound requests", () => {
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null }),
    },
  });
  vm.runInContext(source, context);
  assert.throws(
    () => vm.runInContext("directoryMapping_()", context),
    /configure exact/,
  );
  assert.ok(!/UrlFetchApp|openById|newTrigger/.test(source));
});
