import { z } from "zod";
export const storeSchema = z
  .object({
    id: z.string().min(1).max(40),
    state: z.string().min(1),
    brand: z.string().min(1),
    name: z.string().min(1),
    posSource: z.string().min(1),
  })
  .strict();
export type Store = z.infer<typeof storeSchema>;
export const inputSchema = z
  .object({
    storeId: z.string().min(1).max(40),
    posSource: z.string().min(1).max(40),
    posEmployeeId: z.string().trim().min(1).max(80),
    posName: z.string().trim().min(1).max(160),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    preferredName: z.string().trim().max(100).default(""),
    aliases: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict();
export type EmployeeInput = z.infer<typeof inputSchema>;
export type Verification = "awaiting" | "confirmed" | "review" | "manual";
export type Employee = EmployeeInput & {
  id: string;
  personId?: string;
  posIdentityPending?: boolean;
  state: string;
  brand: string;
  verification: Verification;
  observedPosName?: string;
  observedAt?: string;
  manualReason?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};
export type Account = { id: string; role: "store" | "admin"; storeId?: string };
export const ADMIN_ACCOUNT_ID = "IDADadmin";
export type Access = {
  id: string;
  kind: "credential" | "session" | "attempt";
  account?: Account;
  hash?: string;
  salt?: string;
  expiresAt?: number;
  count?: number;
  accountId?: string;
};
export type Audit = {
  id: string;
  at: string;
  actor: string;
  action: string;
  employeeId?: string;
  storeId?: string;
  reason?: string;
  before?: Employee;
  after?: Employee;
};
export const rosterSchema = z
  .object({
    source: z.string().min(1),
    observedAt: z.iso.datetime(),
    complete: z.literal(true),
    stores: z.array(z.string()).min(1),
    rowCount: z.number().int().positive(),
    rows: z
      .array(
        z
          .object({
            storeId: z.string(),
            posSource: z.string(),
            posEmployeeId: z.string().trim().min(1),
            posName: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Roster = z.infer<typeof rosterSchema>;
export type RosterCandidate = {
  id: string;
  storeId: string;
  posSource: string;
  posEmployeeId: string;
  posName: string;
  firstSeen: string;
  lastSeen: string;
  archivedAt?: string;
  archivedBy?: string;
};
export type ScheduleTargetState = "texas" | "california";
export type ScheduleTarget = {
  state: ScheduleTargetState;
  targetKey: string;
  kind: "test" | "schedule";
  scheduleId: string;
  spreadsheetId: string;
  sheetName: string;
  sheetUrl: string;
  weekStart?: string;
  weekEnd?: string;
  selectedAt: string;
  selectedBy: string;
  readiness: "test-draft" | "needs-preparation" | "ready" | "sync-failed";
  lastSync?: {
    at: string;
    status: "ready" | "failed";
    message?: string;
  };
};
export type State = {
  employees: Employee[];
  access: Access[];
  audit: Audit[];
  sync: {
    people?: Record<string, { homeStoreId: string; multiStore: boolean }>;
    snapshot?: Roster;
    lastSuccess?: string;
    lastAttempt?: string;
    error?: string;
    version: number;
    leases?: Record<string, { owner: string; expiresAt: number }>;
    candidates?: RosterCandidate[];
    automation?: {
      heartbeat?: string;
      lastRoster?: string;
      lastDraft?: string;
      error?: string;
      cadence?: "daily";
      lastDailyDate?: string;
    };
    scheduleTargets?: Partial<Record<ScheduleTargetState, ScheduleTarget>>;
    draftExports?: Record<string, import("./draft-schedule").DraftExport>;
  };
};
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const displayName = (
  e: Pick<Employee, "preferredName" | "firstName" | "lastName">,
) => e.preferredName.trim() || `${e.firstName} ${Array.from(e.lastName)[0]}.`;
export const identityKey = (e: {
  storeId: string;
  posSource: string;
  posEmployeeId: string;
}) => JSON.stringify([e.storeId, e.posSource, e.posEmployeeId]);
export const normalizedName = (s: string) =>
  s.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
export function canAccess(a: Account, _storeId: string) {
  return a.role === "admin";
}
export function requireStore(a: Account, storeId: string) {
  if (!canAccess(a, storeId))
    throw new Problem(403, "IDAD Admin Profile access required.");
}
export function requireAdmin(a: Account) {
  if (a.role !== "admin")
    throw new Problem(403, "Administrator access required.");
}

/** Pending keys exist only to preserve the scoped database unique index. */
export const posPending = (
  e: Pick<Employee, "posEmployeeId" | "posIdentityPending">,
) => e.posIdentityPending === true || e.posEmployeeId.startsWith("pending:");
export const personId = (e: Employee) => e.personId || e.id;

export type ResolvedPosIdentity = {
  posEmployeeId: string;
  posIdentityPending: boolean;
};

/**
 * Qu employee IDs are global across Qu stores. A pending assignment may use one
 * unique ID already verified on another assignment for the same linked person.
 * Ambiguous IDs and destination-store collisions remain pending.
 */
export function resolvedPosIdentity(
  employee: Employee,
  employees: Employee[],
): ResolvedPosIdentity {
  if (!posPending(employee))
    return {
      posEmployeeId: employee.posEmployeeId,
      posIdentityPending: false,
    };
  if (employee.posSource.toLocaleLowerCase("en-US") !== "qu")
    return { posEmployeeId: "", posIdentityPending: true };

  const id = personId(employee);
  const verified = employees.filter(
    (other) =>
      other.id !== employee.id &&
      personId(other) === id &&
      other.posSource.toLocaleLowerCase("en-US") === "qu" &&
      !posPending(other) &&
      ["confirmed", "manual"].includes(other.verification),
  );
  const ids = [...new Set(verified.map((other) => other.posEmployeeId))];
  if (ids.length !== 1)
    return { posEmployeeId: "", posIdentityPending: true };

  const posEmployeeId = ids[0];
  const collision = employees.some(
    (other) =>
      other.id !== employee.id &&
      other.storeId === employee.storeId &&
      other.posSource.toLocaleLowerCase("en-US") === "qu" &&
      !posPending(other) &&
      other.posEmployeeId === posEmployeeId &&
      personId(other) !== id,
  );
  if (collision)
    return { posEmployeeId: "", posIdentityPending: true };

  return {
    posEmployeeId,
    posIdentityPending: false,
  };
}
