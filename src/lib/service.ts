import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { credential } from "./seed";
import { stores } from "./config";
import {
  canAccess,
  displayName,
  identityKey,
  inputSchema,
  normalizedName,
  posPending,
  personId,
  Problem,
  requireAdmin,
  requireStore,
  rosterSchema,
  type Account,
  type Employee,
  type State,
  ADMIN_ACCOUNT_ID,
} from "./model";
const tokenHash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const week = 7 * 24 * 60 * 60 * 1000;
function audit(
  s: State,
  a: Account,
  action: string,
  extra: Partial<State["audit"][number]> = {},
) {
  s.audit.push({ id: randomUUID(), at: now(), actor: a.id, action, ...extra });
}
export function currentAccount(s: State, token?: string): Account {
  if (!token) throw new Problem(401, "Please sign in.");
  const session = s.access.find(
    (x) =>
      x.kind === "session" &&
      x.id === tokenHash(token) &&
      x.expiresAt! > Date.now(),
  );
  const account = s.access.find(
    (x) => x.kind === "credential" && x.id === session?.accountId,
  )?.account;
  if (account?.role !== "admin" || account.id !== ADMIN_ACCOUNT_ID)
    throw new Problem(401, "Your session has ended. Please sign in again.");
  return account;
}
export function login(s: State, body: unknown) {
  const { accountId, code } = z
    .object({
      accountId: z.string().min(1).max(80),
      code: z.string().min(1).max(200),
    })
    .strict()
    .parse(body);
  const time = Date.now();
  s.access = s.access.filter((x) => !x.expiresAt || x.expiresAt > time);
  // Account-scoped limits are shared across every process through the repository transaction.
  const key = `attempt:${tokenHash(accountId)}`;
  let attempt = s.access.find((x) => x.id === key);
  if (attempt && (attempt.count || 0) >= 5)
    return { error: "Too many attempts. Wait 15 minutes.", status: 429 };
  if (!attempt) {
    attempt = {
      id: key,
      kind: "attempt",
      count: 0,
      expiresAt: time + 15 * 60 * 1000,
    };
    s.access.push(attempt);
  }
  const cred = s.access.find(
    (x) => x.kind === "credential" && x.id === accountId,
  );
  const candidate = scryptSync(
    code,
    cred?.salt || "missing-account-dummy-salt",
    64,
  );
  const valid =
    cred?.hash && timingSafeEqual(candidate, Buffer.from(cred.hash, "hex"));
  if (
    !valid ||
    cred?.account?.role !== "admin" ||
    cred.account.id !== ADMIN_ACCOUNT_ID
  ) {
    attempt.count = (attempt.count || 0) + 1;
    return {
      error: "IDAD Admin Profile or access code is incorrect.",
      status: 401,
    };
  }
  s.access = s.access.filter((x) => x.id !== key);
  const token = randomBytes(32).toString("hex");
  s.access.push({
    id: tokenHash(token),
    kind: "session",
    accountId,
    expiresAt: time + week,
  });
  audit(s, cred!.account!, "login");
  return { token, account: cred!.account! };
}
export function logout(s: State, token: string) {
  s.access = s.access.filter(
    (x) => x.kind !== "session" || x.id !== tokenHash(token),
  );
}
export function resetCode(s: State, a: Account, body: unknown) {
  requireAdmin(a);
  const { accountId, code, reason } = z
    .object({
      accountId: z.string(),
      code: z.string().min(1).max(200),
      reason: z.string().trim().min(3).max(500),
    })
    .strict()
    .parse(body);
  const existing = s.access.find(
    (x) => x.kind === "credential" && x.id === accountId,
  );
  if (!existing?.account) throw new Problem(404, "Account not found.");
  if (
    existing.account.role !== "admin" ||
    existing.account.id !== ADMIN_ACCOUNT_ID
  )
    throw new Problem(
      400,
      "Single-store profiles are retired. Update the IDAD Admin Profile instead.",
    );
  s.access = s.access.filter(
    (x) =>
      x.id !== accountId &&
      x.accountId !== accountId &&
      x.id !== `attempt:${tokenHash(accountId)}`,
  );
  s.access.push(
    credential(
      accountId,
      existing.account.role,
      code,
      existing.account.storeId,
    ),
  );
  audit(s, a, "access.reset", { reason });
  return { ok: true };
}
export function listEmployees(s: State, a: Account, storeId?: string) {
  if (storeId) requireStore(a, storeId);
  return s.employees
    .filter(
      (e) => canAccess(a, e.storeId) && (!storeId || e.storeId === storeId),
    )
    .map((e) => ({
      ...e,
      posEmployeeId: posPending(e) ? "" : e.posEmployeeId,
      posIdentityPending: posPending(e),
      displayName: displayName(e),
    }));
}
function verify(s: State, e: Employee) {
  if (posPending(e)) {
    e.verification = "awaiting";
    return;
  }
  const row = s.sync.snapshot?.rows.find(
    (r) => identityKey(r) === identityKey(e),
  );
  if (!row) {
    if (e.verification !== "manual") e.verification = "awaiting";
    return;
  }
  e.observedPosName = row.posName;
  e.observedAt = s.sync.snapshot!.observedAt;
  const agrees = normalizedName(row.posName) === normalizedName(e.posName);
  if (!agrees) {
    e.verification = "review";
    delete e.manualReason;
  } else if (e.verification !== "manual") e.verification = "confirmed";
}
export function saveEmployee(s: State, a: Account, body: unknown, id?: string) {
  const schema = inputSchema.extend({
    posEmployeeId: z.string().trim().max(80),
    revision: z.number().int().positive().optional(),
    reason: z.string().trim().max(500).optional(),
  });
  const parsed = schema.parse(body);
  const { revision, reason, ...fields } = parsed;
  const old = id ? s.employees.find((e) => e.id === id) : undefined;
  if (id && !old) throw new Problem(404, "Employee not found.");
  if (old) requireStore(a, old.storeId);
  if (fields.posEmployeeId.startsWith("pending:"))
    throw new Problem(400, "Reserved POS identity.");
  if (!fields.posEmployeeId) {
    if (!old || !posPending(old))
      throw new Problem(400, "POS employee ID is required.");
    fields.posEmployeeId = old.posEmployeeId;
  }
  requireStore(a, fields.storeId);
  if (old && old.storeId !== fields.storeId)
    throw new Problem(
      400,
      "Create a separate assignment for another store; historical assignments cannot be moved.",
    );
  const store = stores().find((x) => x.id === fields.storeId);
  if (!store || fields.posSource !== store.posSource)
    throw new Problem(400, "Choose an enabled store and its POS source.");
  if (old && old.revision !== revision)
    throw new Problem(
      409,
      "This employee changed since you opened the form. Reload before saving.",
    );
  const identityChanged =
    old &&
    (identityKey(old) !== identityKey(fields) ||
      old.posName !== fields.posName);
  if (identityChanged) {
    requireAdmin(a);
    if (!reason || reason.length < 3)
      throw new Problem(400, "Explain the identity correction.");
  }
  if (
    s.employees.some(
      (e) => e.id !== id && identityKey(e) === identityKey(fields),
    )
  )
    throw new Problem(
      409,
      "That POS employee ID already exists at this store.",
    );
  const profile = old && s.sync.people?.[personId(old)];
  if (
    old &&
    fields.status === "active" &&
    profile &&
    !profile.multiStore &&
    old.storeId !== profile.homeStoreId
  )
    throw new Problem(
      409,
      "An administrator must enable multi-store before reactivating this assignment.",
    );
  const at = now();
  const employee: Employee = {
    ...fields,
    ...(old?.personId ? { personId: old.personId } : {}),
    ...(old?.posIdentityPending
      ? { posIdentityPending: fields.posEmployeeId === old.posEmployeeId }
      : {}),
    id: old?.id || randomUUID(),
    state: store.state,
    brand: store.brand,
    revision: (old?.revision || 0) + 1,
    createdAt: old?.createdAt || at,
    updatedAt: at,
    updatedBy: a.id,
    verification: old?.verification || "awaiting",
    ...(old?.observedAt
      ? { observedAt: old.observedAt, observedPosName: old.observedPosName }
      : {}),
    ...(old?.manualReason ? { manualReason: old.manualReason } : {}),
  };
  if (identityChanged) {
    employee.verification = "awaiting";
    delete employee.manualReason;
    delete employee.observedAt;
    delete employee.observedPosName;
  }
  verify(s, employee);
  if (old) s.employees[s.employees.findIndex((e) => e.id === id)] = employee;
  else s.employees.push(employee);
  audit(s, a, old ? "employee.update" : "employee.create", {
    employeeId: employee.id,
    storeId: employee.storeId,
    before: old,
    after: structuredClone(employee),
    reason,
  });
  return {
    ...employee,
    posEmployeeId: posPending(employee) ? "" : employee.posEmployeeId,
    displayName: displayName(employee),
  };
}
export function manualVerify(s: State, a: Account, id: string, body: unknown) {
  requireAdmin(a);
  const { reason, revision } = z
    .object({
      reason: z.string().trim().min(3).max(500),
      revision: z.number().int().positive(),
    })
    .strict()
    .parse(body);
  const employee = s.employees.find((x) => x.id === id);
  if (!employee) throw new Problem(404, "Employee not found.");
  if (employee.revision !== revision)
    throw new Problem(409, "Employee changed. Reload before verifying.");
  if (posPending(employee))
    throw new Problem(
      409,
      "Link a destination-store POS identity before verifying.",
    );
  const before = structuredClone(employee);
  Object.assign(employee, {
    verification: "manual",
    manualReason: reason,
    revision: employee.revision + 1,
    updatedAt: now(),
    updatedBy: a.id,
  });
  audit(s, a, "employee.manual-verification", {
    employeeId: id,
    storeId: employee.storeId,
    before,
    after: structuredClone(employee),
    reason,
  });
  return employee;
}
export function refresh(s: State, a: Account, body: unknown) {
  requireAdmin(a);
  s.sync.lastAttempt = now();
  try {
    const snapshot = rosterSchema.parse(body);
    if (snapshot.rows.some((r) => r.posEmployeeId.startsWith("pending:")))
      throw new Problem(400, "Roster contains a reserved POS identity.");
    const expected = stores()
      .map((x) => x.id)
      .sort();
    if (
      JSON.stringify([...snapshot.stores].sort()) !== JSON.stringify(expected)
    )
      throw new Problem(
        400,
        "Refresh must cover every enabled store exactly once.",
      );
    if (snapshot.rowCount !== snapshot.rows.length)
      throw new Problem(400, "Roster row count is incomplete.");
    if (new Set(snapshot.rows.map(identityKey)).size !== snapshot.rows.length)
      throw new Problem(400, "Roster contains duplicate POS identities.");
    if (
      snapshot.rows.some(
        (r) =>
          !stores().some(
            (x) => x.id === r.storeId && x.posSource === r.posSource,
          ),
      )
    )
      throw new Problem(400, "Roster contains an unknown store or POS source.");
    if (Date.parse(snapshot.observedAt) > Date.now() + 300000)
      throw new Problem(400, "Roster timestamp is in the future.");
    if (s.sync.snapshot && snapshot.observedAt < s.sync.snapshot.observedAt)
      throw new Problem(
        400,
        "An older roster cannot replace the latest snapshot.",
      );
    for (const id of expected) {
      const count = snapshot.rows.filter((x) => x.storeId === id).length;
      const old =
        s.sync.snapshot?.rows.filter((x) => x.storeId === id).length || 0;
      if (!count || count < old * 0.8)
        throw new Problem(
          400,
          "Roster is empty or unexpectedly smaller for a store; review the source.",
        );
    }
    s.sync.candidates ??= [];
    for (const row of snapshot.rows) {
      if (s.employees.some((e) => identityKey(e) === identityKey(row)))
        continue;
      const found = s.sync.candidates.find(
        (c) => identityKey(c) === identityKey(row),
      );
      if (found) {
        found.posName = row.posName;
        found.lastSeen = snapshot.observedAt;
      } else
        s.sync.candidates.push({
          ...row,
          id: randomUUID(),
          firstSeen: snapshot.observedAt,
          lastSeen: snapshot.observedAt,
        });
    }
    s.sync.snapshot = snapshot;
    s.sync.lastSuccess = now();
    delete s.sync.error;
    for (const e of s.employees) {
      const before = structuredClone(e);
      verify(s, e);
      if (JSON.stringify(e) !== JSON.stringify(before)) {
        e.revision++;
        e.updatedAt = now();
        e.updatedBy = a.id;
        audit(s, a, "employee.roster-verification", {
          employeeId: e.id,
          storeId: e.storeId,
          before,
          after: structuredClone(e),
        });
      }
    }
    audit(s, a, "roster.refresh");
    return { ok: true, rowCount: snapshot.rows.length };
  } catch (e) {
    s.sync.error =
      e instanceof z.ZodError
        ? "Invalid or incomplete roster format."
        : (e as Error).message;
    return { error: s.sync.error, status: 400 };
  }
}
export function rosterRows(s: State, a: Account, storeId: string) {
  return listEmployees(s, a, storeId)
    .filter((e) => e.status === "active")
    .map((e) => ({
      ...e,
      dropdownLabel:
        e.displayName +
        (s.employees.filter(
          (o) =>
            o.storeId === e.storeId &&
            o.status === "active" &&
            displayName(o) === e.displayName,
        ).length > 1
          ? posPending(e)
            ? ` (${e.firstName} ${e.lastName})`
            : ` · ${e.posEmployeeId}`
          : ""),
    }));
}
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rosterCsv(s: State, a: Account, storeId: string) {
  return [
    ["Store ID", "Employee name", "Employee ID"],
    ...rosterRows(s, a, storeId).map((e) => [
      e.storeId,
      e.displayName,
      e.posEmployeeId,
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export function listCandidates(
  s: State,
  a: Account,
  storeId?: string,
  status: "pending" | "archived" = "pending",
) {
  if (storeId) requireStore(a, storeId);
  return (s.sync.candidates || [])
    .filter(
      (c) =>
        canAccess(a, c.storeId) &&
        (!storeId || c.storeId === storeId) &&
        (status === "archived" ? !!c.archivedAt : !c.archivedAt) &&
        !s.employees.some((e) => identityKey(e) === identityKey(c)),
    )
    .map((c) => ({
      ...c,
      inCurrentRoster: !!s.sync.snapshot?.rows.some(
        (r) => identityKey(r) === identityKey(c),
      ),
    }));
}
export function setCandidateArchived(
  s: State,
  a: Account,
  id: string,
  archived: boolean,
) {
  requireAdmin(a);
  const candidate = (s.sync.candidates || []).find((c) => c.id === id);
  if (!candidate) throw new Problem(404, "Candidate not found.");
  if (s.employees.some((e) => identityKey(e) === identityKey(candidate)))
    throw new Problem(
      409,
      "This POS identity is already in the directory. Refresh the list.",
    );
  if (archived === !!candidate.archivedAt) return candidate;
  if (archived) {
    candidate.archivedAt = now();
    candidate.archivedBy = a.id;
  } else {
    delete candidate.archivedAt;
    delete candidate.archivedBy;
  }
  audit(
    s,
    a,
    archived ? "employee.candidate-archived" : "employee.candidate-restored",
    {
      storeId: candidate.storeId,
      reason: `${candidate.posName} · ${candidate.posEmployeeId}`,
    },
  );
  return candidate;
}
export function acceptCandidate(
  s: State,
  a: Account,
  id: string,
  body: unknown,
) {
  const candidate = (s.sync.candidates || []).find((c) => c.id === id);
  if (!candidate) throw new Problem(404, "Candidate not found.");
  requireStore(a, candidate.storeId);
  if (candidate.archivedAt)
    throw new Problem(
      409,
      "This review is archived. Return it to review before adding the employee.",
    );
  if (s.employees.some((e) => identityKey(e) === identityKey(candidate)))
    throw new Problem(
      409,
      "This POS identity is already in the directory. Refresh the list.",
    );
  const fields = inputSchema.parse(body);
  if (
    identityKey(fields) !== identityKey(candidate) ||
    fields.posName !== candidate.posName
  )
    throw new Problem(
      409,
      "POS details changed. Reopen this candidate before confirming.",
    );
  const employee = saveEmployee(s, a, fields);
  audit(s, a, "employee.candidate-accepted", {
    employeeId: employee.id,
    storeId: candidate.storeId,
  });
  return employee;
}
