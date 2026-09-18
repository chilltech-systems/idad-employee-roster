import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed";
import {
  listPeople,
  savePerson,
  linkPeople,
  linkCandidate,
  migrationPreview,
} from "../src/lib/people";
import {
  listCandidates,
  refresh,
  saveEmployee,
  rosterRows,
  manualVerify,
  setCandidateArchived,
} from "../src/lib/service";
import { exportShifts, laborPreview } from "../src/lib/shifts";
import { assertStateTransition } from "../src/lib/storage-scope";
import {
  resolvedPosIdentity,
  type Account,
  type State,
} from "../src/lib/model";
const admin: Account = { id: "IDADadmin", role: "admin" };
const manager: Account = {
  id: "TX-DEMO-2",
  role: "store",
  storeId: "TX-DEMO-2",
};
function profile(s: State, id = "demo-1") {
  return listPeople(s, admin).find((p) => p.id === id)!;
}
function assign(s: State, id = "demo-1") {
  const p = profile(s, id);
  return savePerson(s, admin, id, {
    revision: p.revision,
    firstName: p.firstName,
    lastName: p.lastName,
    preferredName: p.preferredName,
    homeStoreId: p.homeStoreId,
    multiStore: true,
    assignments: [
      { storeId: p.homeStoreId, status: "active" },
      { storeId: "TX-DEMO-2", status: "active" },
    ],
  });
}
function snapshot(s: State) {
  const rows = s.employees
    .filter((e) => !e.posIdentityPending)
    .map(({ storeId, posSource, posEmployeeId, posName }) => ({
      storeId,
      posSource,
      posEmployeeId,
      posName,
    }));
  return {
    source: "fixture",
    observedAt: new Date().toISOString(),
    complete: true,
    stores: ["TX-DEMO-1", "TX-DEMO-2"],
    rowCount: rows.length,
    rows,
  };
}
test("migration preview is read-only, alphabetical and never merges equal names", () => {
  const s = seed();
  s.employees[6].firstName = s.employees[0].firstName;
  s.employees[6].lastName = s.employees[0].lastName;
  const before = structuredClone(s),
    p = migrationPreview(s, admin);
  assert.deepEqual(s, before);
  assert.equal(p.profileCount, 7);
  assert.equal(p.possibleLinks.length, 1);
  assert.equal(p.profiles[0].firstName, "Alex");
  assert.equal(profile(s).homeStoreId, "TX-DEMO-1");
});
test("one verified Qu identity carries to linked stores while unresolved assignments stay pending", () => {
  const s = seed();
  assign(s);
  assign(s, "demo-2");
  const roster = rosterRows(s, admin, "TX-DEMO-2");
  const inherited = roster.find((e) => e.personId === "demo-1")!;
  assert.equal(inherited.posIdentityPending, false);
  assert.equal(inherited.posEmployeeId, "00101");
  const unresolved = roster.find((e) => e.personId === "demo-2")!;
  assert.equal(unresolved.posIdentityPending, true);
  assert.equal(unresolved.posEmployeeId, "");
  assertStateTransition(seed(), s);
  assert.throws(() => listPeople(s, manager), /Administrator/);
  assert.throws(() => savePerson(s, manager, "demo-1", {}), /Administrator/);
  assert.throws(() => linkPeople(s, manager, "demo-1", {}), /Administrator/);
  assert.throws(() => linkCandidate(s, manager, "demo-1", {}), /Administrator/);
});
test("admin deactivation is local and pending identities and manual assignments survive repeated refresh", () => {
  const s = seed();
  assign(s);
  const e = rosterRows(s, admin, "TX-DEMO-2").find(
    (e) => e.personId === "demo-1",
  )!;
  saveEmployee(
    s,
    admin,
    {
      storeId: e.storeId,
      posSource: e.posSource,
      posEmployeeId: "",
      posName: e.posName,
      firstName: e.firstName,
      lastName: e.lastName,
      preferredName: e.preferredName,
      aliases: e.aliases,
      status: "inactive",
      revision: e.revision,
    },
    e.id,
  );
  const settings = structuredClone(s.sync.people);
  for (let i = 0; i < 3; i++)
    assert.equal(refresh(s, admin, snapshot(s)).ok, true);
  assert.deepEqual(s.sync.people, settings);
  assert.equal(s.employees.find((x) => x.id === e.id)!.status, "inactive");
  assert.equal(s.employees.find((x) => x.id === "demo-1")!.status, "active");
  assert.equal(s.employees.find((x) => x.id === e.id)!.personId, "demo-1");
  assert.throws(
    () =>
      manualVerify(s, admin, e.id, {
        revision: s.employees.find((x) => x.id === e.id)!.revision,
        reason: "test reason",
      }),
    /Link a destination/,
  );
});
test("turning off multi-store requires confirmation and retains assignments/history; stale edits fail", () => {
  const s = seed();
  const p = assign(s);
  const oldIds = s.employees.map((e) => e.id);
  const payload = {
    revision: p.revision,
    firstName: p.firstName,
    lastName: p.lastName,
    preferredName: p.preferredName,
    homeStoreId: p.homeStoreId,
    multiStore: false,
    assignments: [{ storeId: p.homeStoreId, status: "active" }],
  };
  assert.throws(
    () => savePerson(s, admin, p.id, payload),
    /Confirm deactivation/,
  );
  savePerson(s, admin, p.id, { ...payload, confirmDeactivateAdditional: true });
  assert.deepEqual(
    s.employees.map((e) => e.id),
    oldIds,
  );
  assert.equal(
    profile(s).assignments.find((e) => e.storeId === "TX-DEMO-2")!.status,
    "inactive",
  );
  assert.throws(() => savePerson(s, admin, p.id, payload), /changed/);
});
test("explicit profile link selects home store and preserves existing IDs; duplicate store link is atomic", () => {
  const s = seed(),
    a = profile(s),
    b = profile(s, "demo-7"),
    ids = s.employees.map((e) => [e.id, e.posEmployeeId]);
  const p = linkPeople(s, admin, a.id, {
    revision: a.revision,
    otherId: b.id,
    otherRevision: b.revision,
    homeStoreId: "TX-DEMO-2",
    confirmed: true,
  });
  assert.equal(p.homeStoreId, "TX-DEMO-2");
  assert.equal(listPeople(s, admin).length, 6);
  assert.deepEqual(
    s.employees.map((e) => [e.id, e.posEmployeeId]),
    ids,
  );
  const before = structuredClone(s),
    other = profile(s, "demo-2");
  assert.throws(
    () =>
      linkPeople(s, admin, p.id, {
        revision: p.revision,
        otherId: other.id,
        otherRevision: other.revision,
        homeStoreId: "TX-DEMO-1",
        confirmed: true,
      }),
    /same store/,
  );
  assert.deepEqual(s, before);
});
test("new-store POS discovery stays in review and explicit linking verifies the existing pending assignment without reactivation", () => {
  const s = seed();
  assign(s);
  const pending = s.employees.find((e) => e.posIdentityPending)!;
  pending.status = "inactive";
  const r = snapshot(s);
  r.rows.push({
    storeId: "TX-DEMO-2",
    posSource: "Qu",
    posEmployeeId: "fresh-901",
    posName: "Maya Bennett",
  });
  r.rowCount++;
  assert.equal(refresh(s, admin, r).ok, true);
  const candidate = listCandidates(s, admin).find(
    (c) => c.posEmployeeId === "fresh-901",
  )!;
  assert.ok(candidate);
  assert.equal(pending.posIdentityPending, true);
  const p = profile(s);
  setCandidateArchived(s, admin, candidate.id, true);
  assert.throws(
    () =>
      linkCandidate(s, admin, p.id, {
        revision: p.revision,
        candidateId: candidate.id,
        posEmployeeId: candidate.posEmployeeId,
        posName: candidate.posName,
        confirmed: true,
      }),
    /archived/,
  );
  setCandidateArchived(s, admin, candidate.id, false);
  linkCandidate(s, admin, p.id, {
    revision: p.revision,
    candidateId: candidate.id,
    posEmployeeId: candidate.posEmployeeId,
    posName: candidate.posName,
    confirmed: true,
  });
  assert.equal(pending.status, "inactive");
  assert.equal(pending.verification, "confirmed");
  assert.equal(pending.posEmployeeId, "fresh-901");
  assert.equal(listCandidates(s, admin).length, 0);
  assert.equal(profile(s).homeStoreId, "TX-DEMO-1");
});
test("verified Qu IDs carry to linked stores while punch matching remains store-scoped", () => {
  const s = seed();
  assign(s);
  const e = s.employees.find((e) => e.posIdentityPending)!;
  const input = {
    workbookId: "fixture",
    weekStart: "2026-09-06",
    revision: 1,
    cells: [
      {
        sheet: "Texas Schedule",
        row: 1,
        slot: "shift",
        storeId: e.storeId,
        directoryId: e.id,
        businessDate: "2026-09-07",
        start: "09:00",
        end: "15:00",
        overnight: false,
      },
    ],
  };
  const exported = exportShifts(input, s.employees);
  assert.equal(exported.ready, true);
  assert.equal(exported.shifts[0].storeId, "TX-DEMO-2");
  assert.equal(exported.shifts[0].posEmployeeId, "00101");
  assert.equal(exported.shifts[0].posIdentityPending, false);
  assert.equal(exported.shifts[0].personId, "demo-1");
  const punch = {
    id: "p",
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: "00101",
    businessDate: "2026-09-07",
    start: "2026-09-07T09:00:00-05:00",
    end: "2026-09-07T15:00:00-05:00",
  };
  const result = laborPreview(exported, [punch]);
  assert.equal(result.records[0].result, "no-punch");
  assert.deepEqual(result.unmatchedPunchIds, ["p"]);
  assert.equal(
    laborPreview(exported, [
      { ...punch, storeId: e.storeId },
    ]).records[0].result,
    "matched",
  );
  e.posEmployeeId = "destination-17";
  e.posIdentityPending = false;
  e.verification = "confirmed";
  assert.equal(
    laborPreview(exportShifts(input, s.employees), [punch]).records[0].result,
    "no-punch",
  );
  assert.equal(
    laborPreview(exportShifts(input, s.employees), [
      { ...punch, storeId: e.storeId, posEmployeeId: e.posEmployeeId },
    ]).records[0].result,
    "matched",
  );
});

test("Qu carry-over fails closed for ambiguous sibling IDs or destination collisions", () => {
  const s = seed();
  assign(s);
  const pending = s.employees.find(
    (employee) => employee.personId === "demo-1" && employee.posIdentityPending,
  )!;
  s.employees.push({
    ...s.employees[0],
    id: "other-verified-assignment",
    personId: "demo-1",
    storeId: "TX-OTHER",
    posEmployeeId: "different-id",
  });
  assert.equal(resolvedPosIdentity(pending, s.employees).posIdentityPending, true);

  s.employees.pop();
  s.employees.push({
    ...s.employees[1],
    id: "destination-collision",
    storeId: pending.storeId,
    posEmployeeId: "00101",
    verification: "confirmed",
  });
  assert.equal(resolvedPosIdentity(pending, s.employees).posIdentityPending, true);
});

test("blank legacy POS IDs fail export instead of becoming implicitly pending", () => {
  const s = seed();
  s.employees[0].posEmployeeId = "";
  const result = exportShifts(
    {
      workbookId: "fixture",
      weekStart: "2026-09-06",
      revision: 1,
      cells: [
        {
          sheet: "Texas Schedule",
          row: 1,
          slot: "shift",
          storeId: "TX-DEMO-1",
          directoryId: "demo-1",
          businessDate: "2026-09-07",
          start: "09:00",
          end: "15:00",
          overnight: false,
        },
      ],
    },
    s.employees,
  );
  assert.equal(result.ready, false);
  assert.equal(result.valid, 0);
});

test("shared profiles persist through repository reload and rejected transactions leave no partial assignments", async () => {
  const { FileRepository } = await import("../src/lib/repository");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "directory-people-"));
  try {
    const repo = new FileRepository(path.join(dir, "state.json"));
    await repo.transact((s) => assign(s));
    const before = await new FileRepository(
      path.join(dir, "state.json"),
    ).transact((s) => structuredClone(s));
    assert.equal(profile(before).assignments.length, 2);
    await assert.rejects(
      repo.transact((s) => {
        assign(s, "demo-2");
        throw Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await repo.transact((s) => structuredClone(s)), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
