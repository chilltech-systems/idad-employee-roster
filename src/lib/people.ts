import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { stores } from "./config";
import {
  displayName,
  personId,
  posPending,
  Problem,
  requireAdmin,
  type Account,
  type Employee,
  type State,
} from "./model";

export const personUpdateSchema = z
  .object({
    revision: z.string(),
    homeStoreId: z.string(),
    multiStore: z.boolean(),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    preferredName: z.string().trim().max(100),
    assignments: z
      .array(
        z
          .object({
            storeId: z.string(),
            status: z.enum(["active", "inactive"]),
          })
          .strict(),
      )
      .min(1),
    confirmDeactivateAdditional: z.boolean().default(false),
  })
  .strict();
export const personLinkSchema = z
  .object({
    revision: z.string(),
    otherId: z.string(),
    otherRevision: z.string(),
    homeStoreId: z.string(),
    confirmed: z.literal(true),
  })
  .strict();
export const candidateLinkSchema = z
  .object({
    revision: z.string(),
    candidateId: z.string(),
    posEmployeeId: z.string(),
    posName: z.string(),
    confirmed: z.literal(true),
  })
  .strict();
export function listPeople(s: State, a: Account) {
  requireAdmin(a);
  const ids = [...new Set(s.employees.map(personId))];
  return ids
    .map((id) => {
      const assignments = s.employees
        .filter((e) => personId(e) === id)
        .sort((a, b) => a.storeId.localeCompare(b.storeId));
      const settings = s.sync.people?.[id] || {
        homeStoreId: assignments[0].storeId,
        multiStore: false,
      };
      const home = assignments.find((e) => e.storeId === settings.homeStoreId)!;
      if (!home)
        throw new Problem(
          409,
          "Employee home assignment is missing; review required.",
        );
      return {
        id,
        ...settings,
        firstName: home.firstName,
        lastName: home.lastName,
        preferredName: home.preferredName,
        displayName: displayName(home),
        revision: createHash("sha256")
          .update(JSON.stringify([settings, assignments]))
          .digest("hex"),
        assignments: assignments.map((e) => ({
          ...e,
          posEmployeeId: posPending(e) ? "" : e.posEmployeeId,
          posIdentityPending: posPending(e),
        })),
      };
    })
    .sort(
      (a, b) =>
        a.firstName.localeCompare(b.firstName, "en", { sensitivity: "base" }) ||
        a.lastName.localeCompare(b.lastName, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
}
export type PersonView = ReturnType<typeof listPeople>[number];
function checked(s: State, a: Account, id: string, revision: string) {
  const p = listPeople(s, a).find((p) => p.id === id);
  if (!p) throw new Problem(404, "Employee profile not found.");
  if (p.revision !== revision)
    throw new Problem(
      409,
      "Employee changed. Reload the profile before saving.",
    );
  return p;
}
function changed(
  s: State,
  a: Account,
  before: Employee | undefined,
  after: Employee,
  action: string,
  reason?: string,
) {
  after.revision = (before?.revision || 0) + 1;
  after.updatedAt = new Date().toISOString();
  after.updatedBy = a.id;
  s.audit.push({
    id: randomUUID(),
    at: after.updatedAt,
    actor: a.id,
    action,
    employeeId: after.id,
    storeId: after.storeId,
    before,
    after: structuredClone(after),
    reason,
  });
}
function pendingAssignment(
  s: State,
  a: Account,
  source: Employee,
  storeId: string,
  id: string,
): Employee {
  const store = stores().find((x) => x.id === storeId);
  if (!store) throw new Problem(400, "Choose an enabled store.");
  const assignmentId = randomUUID(),
    at = new Date().toISOString();
  const e: Employee = {
    id: assignmentId,
    personId: id,
    storeId,
    state: store.state,
    brand: store.brand,
    posSource: store.posSource,
    posEmployeeId: `pending:${assignmentId}`,
    posIdentityPending: true,
    posName: `${source.firstName} ${source.lastName}`,
    firstName: source.firstName,
    lastName: source.lastName,
    preferredName: source.preferredName,
    aliases: [...source.aliases],
    status: "active",
    verification: "awaiting",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    updatedBy: a.id,
  };
  s.employees.push(e);
  changed(s, a, undefined, e, "employee.assignment-created");
  return e;
}
export function savePerson(s: State, a: Account, id: string, body: unknown) {
  requireAdmin(a);
  const p = personUpdateSchema.parse(body);
  const current = checked(s, a, id, p.revision);
  const selected = new Map(p.assignments.map((x) => [x.storeId, x.status]));
  if (
    selected.size !== p.assignments.length ||
    !selected.has(p.homeStoreId) ||
    p.assignments.some((x) => !stores().some((t) => t.id === x.storeId))
  )
    throw new Problem(
      400,
      "Choose unique enabled stores including the home store.",
    );
  if (
    !p.multiStore &&
    p.assignments.some(
      (x) => x.storeId !== p.homeStoreId && x.status === "active",
    )
  )
    throw new Problem(400, "Enable multi-store to activate additional stores.");
  if (
    current.multiStore &&
    !p.multiStore &&
    current.assignments.some(
      (x) => x.storeId !== p.homeStoreId && x.status === "active",
    ) &&
    !p.confirmDeactivateAdditional
  )
    throw new Problem(
      409,
      "Confirm deactivation of additional store assignments.",
    );
  const source = s.employees.find((e) => personId(e) === id)!;
  for (const x of p.assignments)
    if (!s.employees.some((e) => personId(e) === id && e.storeId === x.storeId))
      pendingAssignment(s, a, source, x.storeId, id);
  for (const e of s.employees.filter((e) => personId(e) === id)) {
    const before = structuredClone(e);
    Object.assign(e, {
      personId: id,
      firstName: p.firstName,
      lastName: p.lastName,
      preferredName: p.preferredName,
      status: selected.get(e.storeId) || "inactive",
    });
    changed(
      s,
      a,
      before,
      e,
      "employee.profile-updated",
      `Home store: ${current.homeStoreId} → ${p.homeStoreId}; multi-store: ${p.multiStore}`,
    );
  }
  s.sync.people ??= {};
  s.sync.people[id] = { homeStoreId: p.homeStoreId, multiStore: p.multiStore };
  return listPeople(s, a).find((p) => p.id === id)!;
}
export function linkPeople(s: State, a: Account, id: string, body: unknown) {
  requireAdmin(a);
  const p = personLinkSchema.parse(body);
  const target = checked(s, a, id, p.revision),
    other = checked(s, a, p.otherId, p.otherRevision);
  if (id === other.id)
    throw new Problem(400, "Select a different employee profile.");
  const assignments = [...target.assignments, ...other.assignments];
  if (new Set(assignments.map((e) => e.storeId)).size !== assignments.length)
    throw new Problem(
      409,
      "Both profiles already have an assignment at the same store. Resolve the duplicate before linking; no records were changed.",
    );
  if (!assignments.some((e) => e.storeId === p.homeStoreId))
    throw new Problem(400, "Select a home store from the linked assignments.");
  for (const e of s.employees.filter((e) =>
    [id, other.id].includes(personId(e)),
  )) {
    const before = structuredClone(e);
    e.personId = id;
    changed(
      s,
      a,
      before,
      e,
      "employee.profiles-linked",
      `Reviewed link ${other.id} to ${id}; home store ${p.homeStoreId}`,
    );
  }
  s.sync.people ??= {};
  s.sync.people[id] = { homeStoreId: p.homeStoreId, multiStore: true };
  delete s.sync.people[other.id];
  return listPeople(s, a).find((p) => p.id === id)!;
}
export function linkCandidate(s: State, a: Account, id: string, body: unknown) {
  requireAdmin(a);
  const p = candidateLinkSchema.parse(body);
  const profile = checked(s, a, id, p.revision),
    c = s.sync.candidates?.find((c) => c.id === p.candidateId);
  if (!c || c.posEmployeeId !== p.posEmployeeId || c.posName !== p.posName)
    throw new Problem(409, "POS candidate changed. Reload before linking.");
  if (
    s.employees.some(
      (e) =>
        !posPending(e) &&
        e.storeId === c.storeId &&
        e.posSource === c.posSource &&
        e.posEmployeeId === c.posEmployeeId,
    )
  )
    throw new Problem(
      409,
      "POS identity already assigned. Link the existing profiles instead.",
    );
  let e = s.employees.find(
    (e) => personId(e) === id && e.storeId === c.storeId,
  );
  if (e && !posPending(e))
    throw new Problem(
      409,
      "This store already has a POS identity. Review the conflict in employee details.",
    );
  if (!e)
    e = pendingAssignment(
      s,
      a,
      s.employees.find((e) => personId(e) === id)!,
      c.storeId,
      id,
    );
  const before = structuredClone(e);
  Object.assign(e, {
    personId: id,
    posEmployeeId: c.posEmployeeId,
    posName: c.posName,
    posSource: c.posSource,
    posIdentityPending: false,
    verification: "awaiting",
  });
  const observed = s.sync.snapshot?.rows.find(
    (r) =>
      r.storeId === c.storeId &&
      r.posSource === c.posSource &&
      r.posEmployeeId === c.posEmployeeId,
  );
  if (observed)
    Object.assign(e, {
      verification: observed.posName === c.posName ? "confirmed" : "review",
      observedAt: s.sync.snapshot!.observedAt,
      observedPosName: observed.posName,
    });
  changed(s, a, before, e, "employee.candidate-linked");
  s.sync.people ??= {};
  s.sync.people[id] = {
    homeStoreId: profile.homeStoreId,
    multiStore: profile.multiStore || c.storeId !== profile.homeStoreId,
  };
  return listPeople(s, a).find((p) => p.id === id)!;
}
/** Read-only compatibility preview: legacy IDs become distinct profiles, never guessed merges. */
export function migrationPreview(s: State, a: Account) {
  const profiles = listPeople(s, a);
  const groups = new Map<string, string[]>();
  for (const p of profiles) {
    const key = `${p.firstName} ${p.lastName}`
      .trim()
      .toLocaleLowerCase("en-US");
    groups.set(key, [...(groups.get(key) || []), p.id]);
  }
  return {
    assignmentCount: s.employees.length,
    profileCount: profiles.length,
    legacyProfiles: profiles.filter((p) => !s.sync.people?.[p.id]).length,
    possibleLinks: [...groups.values()].filter((ids) => ids.length > 1),
    writes: 0,
    collectionsAdded: 0,
    profiles,
  };
}
