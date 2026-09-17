import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import {
  refresh,
  listCandidates,
  acceptCandidate,
  setCandidateArchived,
  saveEmployee,
} from "../src/lib/service";
import type { Account } from "../src/lib/model";
const admin: Account = { id: "test", role: "admin" },
  manager: Account = { id: "m", role: "store", storeId: "TX-DEMO-1" };
function snapshot() {
  return {
    source: "fixture",
    observedAt: new Date().toISOString(),
    complete: true,
    stores: ["TX-DEMO-1", "TX-DEMO-2"],
    rowCount: 2,
    rows: [
      {
        storeId: "TX-DEMO-1",
        posSource: "Qu",
        posEmployeeId: "00999",
        posName: "New Person",
      },
      {
        storeId: "TX-DEMO-2",
        posSource: "Qu",
        posEmployeeId: "00999",
        posName: "New Person",
      },
    ],
  };
}
test("new identities persist for IDAD Admin review and deduplicate on refresh", () => {
  const s = seed();
  assert.equal(refresh(s, admin, snapshot()).ok, true);
  assert.deepEqual(listCandidates(s, manager), []);
  const c = listCandidates(s, admin, "TX-DEMO-1");
  assert.equal(c.length, 1);
  const id = c[0].id;
  refresh(s, admin, snapshot());
  assert.equal(listCandidates(s, admin, "TX-DEMO-1")[0].id, id);
  assert.equal(s.employees.length, seed().employees.length);
  assert.equal(listCandidates(s, admin).length, 2);
});
test("review acceptance confirms fields, cannot cross store or create duplicates", () => {
  const s = seed();
  refresh(s, admin, snapshot());
  const [a, b] = listCandidates(s, admin);
  const body = {
    storeId: a.storeId,
    posSource: a.posSource,
    posEmployeeId: a.posEmployeeId,
    posName: a.posName,
    firstName: "New",
    lastName: "Person",
    preferredName: "N. Person",
    aliases: [],
    status: "active",
  };
  assert.throws(() => acceptCandidate(s, manager, a.id, body), /Admin Profile/);
  const e = acceptCandidate(s, admin, a.id, body);
  assert.equal(e.verification, "confirmed");
  assert.equal(e.preferredName, "N. Person");
  assert.equal(listCandidates(s, admin, a.storeId).length, 0);
  assert.throws(() => acceptCandidate(s, admin, a.id, body), /already/);
});
test("candidate review can be archived without creating an employee and restored", () => {
  const s = seed();
  const employeeCount = s.employees.length;
  refresh(s, admin, snapshot());
  const candidate = listCandidates(s, admin, "TX-DEMO-1")[0];
  assert.throws(
    () => setCandidateArchived(s, manager, candidate.id, true),
    /Administrator/,
  );

  const archived = setCandidateArchived(s, admin, candidate.id, true);
  assert.equal(s.employees.length, employeeCount);
  assert.equal(archived.archivedBy, admin.id);
  assert.ok(archived.archivedAt);
  assert.equal(listCandidates(s, admin, "TX-DEMO-1").length, 0);
  assert.equal(
    listCandidates(s, admin, "TX-DEMO-1", "archived")[0].id,
    candidate.id,
  );
  assert.match(s.audit.at(-1)!.action, /employee\.candidate-archived/);

  refresh(s, admin, snapshot());
  assert.equal(listCandidates(s, admin, "TX-DEMO-1").length, 0);
  assert.equal(
    listCandidates(s, admin, "TX-DEMO-1", "archived")[0].lastSeen,
    s.sync.snapshot!.observedAt,
  );

  setCandidateArchived(s, admin, candidate.id, false);
  assert.equal(listCandidates(s, admin, "TX-DEMO-1")[0].id, candidate.id);
  assert.equal(listCandidates(s, admin, "TX-DEMO-1", "archived").length, 0);
  assert.equal(s.employees.length, employeeCount);
  assert.match(s.audit.at(-1)!.action, /employee\.candidate-restored/);
});
test("archived candidate cannot be accepted from a stale review screen", () => {
  const s = seed();
  refresh(s, admin, snapshot());
  const candidate = listCandidates(s, admin)[0];
  setCandidateArchived(s, admin, candidate.id, true);
  assert.throws(
    () =>
      acceptCandidate(s, admin, candidate.id, {
        storeId: candidate.storeId,
        posSource: candidate.posSource,
        posEmployeeId: candidate.posEmployeeId,
        posName: candidate.posName,
        firstName: "New",
        lastName: "Person",
        preferredName: "",
        aliases: [],
        status: "active",
      }),
    /archived/,
  );
});
test("manually entered hire is confirmed by exact POS identity without reactivation", () => {
  const s = seed();
  const e = saveEmployee(s, admin, {
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: "00999",
    posName: "New Person",
    firstName: "New",
    lastName: "Person",
    preferredName: "Preferred",
    aliases: [],
    status: "inactive",
  });
  refresh(s, admin, snapshot());
  const updated = s.employees.find((row) => row.id === e.id)!;
  assert.equal(updated.verification, "confirmed");
  assert.equal(updated.status, "inactive");
  assert.equal(updated.preferredName, "Preferred");
  assert.equal(listCandidates(s, admin, "TX-DEMO-1").length, 0);
});
