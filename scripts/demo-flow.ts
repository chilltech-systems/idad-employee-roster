import { mkdir, writeFile } from "node:fs/promises";
import { seed } from "../src/lib/seed";
import { saveEmployee, rosterRows } from "../src/lib/service";
import { exportShifts, laborPreview, replaceSnapshot } from "../src/lib/shifts";
const state = seed();
const account = {
  id: "TX-DEMO-1",
  role: "store" as const,
  storeId: "TX-DEMO-1",
};
const employee = saveEmployee(state, account, {
  storeId: "TX-DEMO-1",
  posSource: "Qu",
  posEmployeeId: "000777",
  posName: "Jamie Cooper",
  firstName: "Jamie",
  lastName: "Cooper",
  preferredName: "",
  aliases: [],
  status: "active",
});
const roster = rosterRows(state, account, "TX-DEMO-1");
const input = {
  workbookId: "fictional-texas-template",
  weekStart: "2026-09-06",
  revision: 1,
  cells: [
    {
      sheet: "TX-DEMO-1",
      row: 12,
      slot: "Monday-1",
      storeId: "TX-DEMO-1",
      directoryId: employee.id,
      businessDate: "2026-09-07",
      start: "09:00",
      end: "15:00",
    },
  ],
};
const snapshot = replaceSnapshot(
  undefined,
  exportShifts(input, state.employees),
);
const preview = laborPreview(snapshot, [
  {
    id: "fictional-punch-1",
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: "000777",
    businessDate: "2026-09-07",
    start: "2026-09-07T09:03:00-05:00",
    end: "2026-09-07T15:02:00-05:00",
  },
]);
await mkdir(".data/demo-flow", { recursive: true });
for (const [name, value] of Object.entries({
  employee,
  roster,
  input,
  snapshot,
  preview,
}))
  await writeFile(
    `.data/demo-flow/${name}.json`,
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
console.log(
  JSON.stringify(
    {
      employeeAdded: true,
      verification: employee.verification,
      rosterContainsEmployee: roster.some((e) => e.id === employee.id),
      validShifts: snapshot.valid,
      exceptions: snapshot.exceptionCount,
      matched: preview.records.filter((r) => r.result === "matched").length,
      output: ".data/demo-flow",
    },
    null,
    2,
  ),
);
