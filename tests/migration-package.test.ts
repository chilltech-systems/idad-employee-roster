import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import {
  approvedStores,
  assertEmptyTarget,
  assertMigrationApproval,
  businessFingerprint,
  digest,
  selectMigration,
} from "../scripts/migration-package";

function source() {
  const state = seed();
  const example = state.employees[0];
  state.employees.push(
    ...Array.from({ length: 90 }, (_, i) => ({
      ...structuredClone(example),
      id: `real-${i}`,
      storeId: approvedStores[i % 8],
      posEmployeeId: `${i}`,
      status: i === 0 ? ("inactive" as const) : ("active" as const),
    })),
  );
  const credential = state.access.find((a) => a.kind === "credential")!;
  state.access = state.access.filter((a) => a.id !== "IDADadmin");
  for (const id of [...approvedStores, "IDADadmin"])
    state.access.push({
      ...credential,
      id,
      account:
        id === "IDADadmin"
          ? { id, role: "admin" }
          : { id, role: "store", storeId: id },
    });
  state.access.push({
    id: "expired-session",
    kind: "session",
    accountId: "IDADadmin",
  });
  state.audit = [
    {
      id: "employee-history",
      at: "2026-09-10",
      actor: "IDADadmin",
      action: "employee.update",
      employeeId: "real-0",
      storeId: approvedStores[0],
    },
    { id: "test-audit", at: "2026-09-10", actor: "test", action: "login" },
  ];
  const rows = state.employees
    .filter((e) => approvedStores.includes(e.storeId))
    .map((e) => ({
      storeId: e.storeId,
      posSource: e.posSource,
      posEmployeeId: e.posEmployeeId,
      posName: e.posName,
    }));
  state.sync = {
    version: 120,
    snapshot: {
      source: "fixture",
      observedAt: "2026-09-10T00:00:00.000Z",
      complete: true,
      stores: approvedStores,
      rowCount: 90,
      rows,
    },
    candidates: [],
    leases: { daily: { owner: "old-worker", expiresAt: 1 } },
    automation: { lastDailyDate: "2026-09-10" },
  };
  return state;
}
test("migration preserves inactive employees and IDs, excludes test sessions and operational sync state", () => {
  const before = source();
  const copy = structuredClone(before);
  const result = selectMigration(before, "2026-09-11T00:00:00.000Z");
  assert.equal(result.employees.length, 90);
  assert.equal(
    result.employees.find((e) => e.id === "real-0")?.status,
    "inactive",
  );
  assert.deepEqual(
    result.employees.find((e) => e.id === "real-0"),
    before.employees.find((e) => e.id === "real-0"),
  );
  assert.equal(result.access.length, 9);
  assert.ok(result.access.every((a) => a.kind === "credential"));
  assert.equal(result.audit.length, 2);
  assert.equal(result.sync.version, 1);
  assert.equal(result.sync.leases, undefined);
  assert.equal(result.sync.automation, undefined);
  assert.deepEqual(before, copy);
});
test("scope mismatches and cross-store historical identities stop migration", () => {
  const missing = source();
  missing.employees.pop();
  assert.throws(() => selectMigration(missing, "now"), /90/);
  const crossed = source();
  crossed.audit[0].storeId = approvedStores[1];
  assert.throws(() => selectMigration(crossed, "now"));
  const credential = source();
  credential.access.find((a) => a.id === "TX-141")!.account!.role = "admin";
  assert.throws(() => selectMigration(credential, "now"));
});
test("new business edits invalidate frozen package; observation timestamps do not", () => {
  const before = source();
  const changed = structuredClone(before);
  const employee = changed.employees.find((e) => e.id === "real-0")!;
  employee.observedAt = "2026-09-11T00:00:00.000Z";
  employee.revision++;
  employee.updatedAt = employee.observedAt;
  assert.equal(businessFingerprint(before), businessFingerprint(changed));
  employee.preferredName = "Updated";
  assert.notEqual(businessFingerprint(before), businessFingerprint(changed));
});
test("empty target and both exact manifest approvals are mandatory", () => {
  assertEmptyTarget({
    employees: [],
    access: [],
    audit: [],
    sync: { version: 0 },
  });
  assert.throws(() =>
    assertEmptyTarget({
      employees: [],
      access: [],
      audit: [],
      sync: { version: 1 },
    }),
  );
  const manifest = { database: "employee_directory", payload: "approved" };
  const hash = digest(manifest);
  assert.throws(() => assertMigrationApproval(manifest));
  assert.throws(() => assertMigrationApproval(manifest, hash));
  assert.throws(() =>
    assertMigrationApproval({ ...manifest, payload: "changed" }, hash, hash),
  );
  assertMigrationApproval(manifest, hash, hash);
});
