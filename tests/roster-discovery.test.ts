import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import {
  refresh,
  listCandidates,
  acceptCandidate,
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
test("new identities persist for review, deduplicate on refresh, and stay store scoped", () => {
  const s = seed();
  assert.equal(refresh(s, admin, snapshot()).ok, true);
  const c = listCandidates(s, manager);
  assert.equal(c.length, 1);
  const id = c[0].id;
  refresh(s, admin, snapshot());
  assert.equal(listCandidates(s, manager)[0].id, id);
  assert.equal(s.employees.length, seed().employees.length);
  assert.equal(listCandidates(s, admin).length, 2);
  assert.throws(() => listCandidates(s, manager, "TX-DEMO-2"), /access/);
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
  assert.throws(() => acceptCandidate(s, manager, b.id, body), /access/);
  const e = acceptCandidate(s, manager, a.id, body);
  assert.equal(e.verification, "confirmed");
  assert.equal(e.preferredName, "N. Person");
  assert.equal(listCandidates(s, manager).length, 0);
  assert.throws(() => acceptCandidate(s, manager, a.id, body), /already/);
});
test("manually entered hire is confirmed by exact POS identity without reactivation", () => {
  const s = seed();
  const e = saveEmployee(s, manager, {
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
  assert.equal(listCandidates(s, manager).length, 0);
});
