import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { credential, seed } from "../src/lib/seed";
import { FileRepository } from "../src/lib/repository";
import { displayName, type Account } from "../src/lib/model";
import {
  currentAccount,
  listEmployees,
  login,
  logout,
  manualVerify,
  refresh,
  resetCode,
  rosterCsv,
  rosterRows,
  saveEmployee,
} from "../src/lib/service";
const manager: Account = {
  id: "TX-DEMO-1",
  role: "store",
  storeId: "TX-DEMO-1",
};
const admin: Account = { id: "IDADadmin", role: "admin" };
const input = {
  storeId: "TX-DEMO-1",
  posSource: "Qu",
  posEmployeeId: "000777",
  posName: "Jamie Cooper",
  firstName: "Jamie",
  lastName: "Cooper",
  preferredName: "",
  aliases: [],
  status: "active" as const,
};
const roster = () => ({
  source: "test",
  observedAt: new Date().toISOString(),
  complete: true,
  stores: ["TX-DEMO-1", "TX-DEMO-2"],
  rowCount: 2,
  rows: [
    {
      storeId: "TX-DEMO-1",
      posSource: "Qu",
      posEmployeeId: "00101",
      posName: " Maya   Bennett ",
    },
    {
      storeId: "TX-DEMO-2",
      posSource: "Qu",
      posEmployeeId: "00901",
      posName: "Casey Lane",
    },
  ],
});
test("retired store accounts are denied while IDAD Admin can use every store", () => {
  const s = seed();
  assert.equal(listEmployees(s, manager).length, 0);
  assert.throws(() => rosterCsv(s, manager, "TX-DEMO-1"), /Admin Profile/);
  assert.throws(() => saveEmployee(s, manager, input), /Admin Profile/);
  assert.equal(listEmployees(s, admin).length, 7);
  assert.match(rosterCsv(s, admin, "TX-DEMO-2"), /Store ID/);
});
test("new hire is schedulable, leading zero ID preserved, overrides clear to default", () => {
  const s = seed();
  const e = saveEmployee(s, admin, input);
  assert.equal(e.verification, "awaiting");
  assert.equal(e.posEmployeeId, "000777");
  assert.equal(e.displayName, "Jamie C.");
  assert.ok(rosterRows(s, admin, input.storeId).some((x) => x.id === e.id));
  const updated = saveEmployee(
    s,
    admin,
    { ...input, preferredName: "JC", revision: e.revision },
    e.id,
  );
  assert.equal(updated.displayName, "JC");
  assert.equal(
    saveEmployee(s, admin, { ...input, revision: updated.revision }, e.id)
      .displayName,
    "Jamie C.",
  );
});
test("same name does not merge records; dropdowns disambiguate", () => {
  const s = seed();
  saveEmployee(s, admin, input);
  saveEmployee(s, admin, { ...input, posEmployeeId: "000778" });
  assert.equal(s.employees.filter((e) => e.firstName === "Jamie").length, 2);
  assert.ok(
    rosterRows(s, admin, input.storeId)
      .filter((e) => e.firstName === "Jamie")
      .every((e) => e.dropdownLabel.includes(e.posEmployeeId)),
  );
});
test("duplicate store/source/ID rejected and same ID at another store remains separate", () => {
  const s = seed();
  saveEmployee(s, admin, input);
  assert.throws(() => saveEmployee(s, admin, input), /already exists/);
  assert.doesNotThrow(() =>
    saveEmployee(s, admin, { ...input, storeId: "TX-DEMO-2" }),
  );
});
test("stale revisions fail; existing identity correction requires admin and reason", () => {
  const s = seed();
  const e = saveEmployee(s, admin, input);
  assert.throws(
    () => saveEmployee(s, admin, { ...input, revision: 99 }, e.id),
    /changed/,
  );
  assert.throws(
    () =>
      saveEmployee(
        s,
        manager,
        { ...input, posName: "Other Name", revision: 1, reason: "Correction" },
        e.id,
      ),
    /Admin Profile/,
  );
  assert.throws(
    () =>
      saveEmployee(
        s,
        admin,
        { ...input, posName: "Other Name", revision: 1 },
        e.id,
      ),
    /Explain/,
  );
  assert.doesNotThrow(() =>
    saveEmployee(
      s,
      admin,
      {
        ...input,
        posName: "Other Name",
        revision: 1,
        reason: "Checked source",
      },
      e.id,
    ),
  );
  assert.equal(s.audit.at(-1)?.before?.posName, "Jamie Cooper");
});
test("historical store assignments cannot be moved", () => {
  const s = seed();
  const e = saveEmployee(s, admin, input);
  assert.throws(
    () =>
      saveEmployee(
        s,
        admin,
        { ...input, storeId: "TX-DEMO-2", revision: 1, reason: "Transfer" },
        e.id,
      ),
    /separate assignment/,
  );
});
test("inactive records retain identities and history; active exports exclude them", () => {
  const s = seed();
  const e = saveEmployee(s, admin, input);
  saveEmployee(s, admin, { ...input, status: "inactive", revision: 1 }, e.id);
  assert.ok(s.employees.some((x) => x.id === e.id));
  assert.ok(!rosterRows(s, admin, input.storeId).some((x) => x.id === e.id));
  assert.equal(s.audit.length, 2);
});
test("roster normalizes whitespace/case without overriding preferences", () => {
  const s = seed();
  s.employees[0].preferredName = "May";
  s.employees[0].aliases = ["M"];
  assert.ok(refresh(s, admin, roster()).ok);
  assert.equal(s.employees[0].verification, "confirmed");
  assert.equal(displayName(s.employees[0]), "May");
  assert.deepEqual(s.employees[0].aliases, ["M"]);
  assert.equal(s.employees.find((e) => e.id === "demo-6")?.status, "inactive");
});
test("an ID-only Qu placeholder is neutral and does not create a false name conflict", () => {
  const s = seed();
  s.employees[0].verification = "review";
  s.employees[0].observedPosName = "Employee 00101";
  const r = roster();
  r.rows[0].posName = "Employee 00101";
  assert.ok(refresh(s, admin, r).ok);
  assert.equal(s.employees[0].verification, "awaiting");
  assert.equal(s.employees[0].observedPosName, "Employee 00101");
});
test("empty, incomplete, duplicate and stale refreshes retain last accepted snapshot", () => {
  const s = seed();
  refresh(s, admin, roster());
  const snapshot = structuredClone(s.sync.snapshot);
  for (const bad of [
    { ...roster(), rows: [] },
    { ...roster(), complete: false },
    { ...roster(), stores: ["TX-DEMO-1"] },
    { ...roster(), rowCount: 3 },
    { ...roster(), rows: [roster().rows[0], roster().rows[0]] },
    { ...roster(), observedAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    assert.ok(refresh(s, admin, bad).error);
    assert.deepEqual(s.sync.snapshot, snapshot);
  }
  assert.equal(s.employees.length, 7);
});
test("manual verification requires reason and later contradiction reopens review", () => {
  const s = seed();
  assert.throws(
    () =>
      manualVerify(s, manager, "demo-1", { reason: "Checked", revision: 1 }),
    /Administrator/,
  );
  manualVerify(s, admin, "demo-1", { reason: "Checked source", revision: 1 });
  assert.equal(s.employees[0].verification, "manual");
  const r = roster();
  r.rows[0].posName = "Different Person";
  refresh(s, admin, r);
  assert.equal(s.employees[0].verification, "review");
  assert.equal(s.employees[0].manualReason, undefined);
});
test("only IDAD Admin can sign in; sessions are hashed and revocable", () => {
  const s = seed();
  s.access.push(
    credential(manager.id, "store", "retired-store-code", manager.storeId),
  );
  assert.equal(
    login(s, {
      accountId: manager.id,
      code: "retired-store-code",
    }).status,
    401,
  );
  const signed = login(s, { accountId: admin.id, code: "demo-admin" });
  assert.ok(signed.token);
  assert.equal(currentAccount(s, signed.token).id, admin.id);
  assert.ok(!JSON.stringify(s).includes(signed.token!));
  logout(s, signed.token!);
  assert.throws(() => currentAccount(s, signed.token), /ended/);
  const token = login(s, { accountId: admin.id, code: "demo-admin" }).token!;
  resetCode(s, admin, {
    accountId: admin.id,
    code: "new-test-code",
    reason: "Test reset",
  });
  assert.throws(() => currentAccount(s, token), /ended/);
  const newToken = login(s, {
    accountId: admin.id,
    code: "new-test-code",
  }).token!;
  s.access.find((x) => x.kind === "session")!.expiresAt = 0;
  assert.throws(() => currentAccount(s, newToken), /ended/);
});
test("failed login limits are shared and retired store profiles cannot be reset", () => {
  const s = seed();
  s.access.push(
    credential(manager.id, "store", "retired-store-code", manager.storeId),
  );
  for (let i = 0; i < 5; i++)
    assert.equal(login(s, { accountId: admin.id, code: "wrong" }).status, 401);
  assert.equal(
    login(s, { accountId: admin.id, code: "demo-admin" }).status,
    429,
  );
  assert.throws(
    () =>
      resetCode(s, manager, {
        accountId: manager.id,
        code: "x",
        reason: "reset",
      }),
    /Administrator/,
  );
  assert.throws(
    () =>
      resetCode(s, admin, {
        accountId: manager.id,
        code: "x",
        reason: "retired",
      }),
    /retired/,
  );
});
test("CSV preserves compatibility headers and neutralizes spreadsheet formulas", () => {
  const s = seed();
  saveEmployee(s, admin, { ...input, preferredName: '=HYPERLINK("x")' });
  const csv = rosterCsv(s, admin, input.storeId);
  assert.ok(csv.startsWith('"Store ID","Employee name","Employee ID"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
});
test("file transactions serialize concurrent edits and never persist partial failure", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "idad-directory-test-"),
  );
  const file = path.join(directory, "state.json");
  const a = new FileRepository(file),
    b = new FileRepository(file);
  await Promise.all([
    a.transact((s) => saveEmployee(s, admin, input)),
    b.transact((s) =>
      saveEmployee(s, admin, { ...input, posEmployeeId: "7772" }),
    ),
  ]);
  const before = await readFile(file, "utf8");
  assert.equal(JSON.parse(before).employees.length, 9);
  await assert.rejects(
    a.transact((s) => {
      s.employees = [];
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.equal(await readFile(file, "utf8"), before);
});
