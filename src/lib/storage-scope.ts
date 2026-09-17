import { personId, posPending, type State } from "./model";
export const PORTAL_COLLECTIONS = {
  employees: "employees",
  access: "employee_directory_access",
  audit: "employee_directory_audit",
  sync: "employee_directory_sync",
} as const;
/** Reject accidental destructive changes before any repository writes occur. */
export function assertStateTransition(before: State, after: State) {
  for (const employee of before.employees) {
    if (!after.employees.some((next) => next.id === employee.id)) {
      throw new Error(
        "Permanent employee records cannot be deleted; use inactive status.",
      );
    }
  }
  const assignments = new Set<string>();
  const identities = new Set<string>();
  for (const e of after.employees) {
    const assignment = JSON.stringify([personId(e), e.storeId]);
    const identity = JSON.stringify([e.storeId, e.posSource, e.posEmployeeId]);
    if (assignments.has(assignment) || identities.has(identity))
      throw new Error("Duplicate employee assignment or POS identity.");
    assignments.add(assignment);
    identities.add(identity);
    if (e.posIdentityPending && e.posEmployeeId !== `pending:${e.id}`)
      throw new Error("Pending assignment identity is invalid.");
    if (e.posEmployeeId.startsWith("pending:") && !e.posIdentityPending)
      throw new Error("Reserved POS identity cannot be verified.");
    if (posPending(e) && ["confirmed", "manual"].includes(e.verification))
      throw new Error("Pending POS identity cannot be verified.");
  }
  for (const [id, profile] of Object.entries(after.sync.people || {})) {
    const rows = after.employees.filter((e) => personId(e) === id);
    if (!rows.some((e) => e.storeId === profile.homeStoreId))
      throw new Error("Home store must have a retained assignment.");
    if (
      !profile.multiStore &&
      rows.some(
        (e) => e.storeId !== profile.homeStoreId && e.status === "active",
      )
    )
      throw new Error(
        "Additional active assignments require multi-store status.",
      );
  }
  const nextAudit = new Map(after.audit.map((entry) => [entry.id, entry]));
  for (const entry of before.audit) {
    if (JSON.stringify(nextAudit.get(entry.id)) !== JSON.stringify(entry)) {
      throw new Error("Existing audit records are immutable.");
    }
  }
  for (const records of [after.employees, after.audit, after.access]) {
    if (new Set(records.map((row) => row.id)).size !== records.length)
      throw new Error("Duplicate storage record ID.");
  }
}
