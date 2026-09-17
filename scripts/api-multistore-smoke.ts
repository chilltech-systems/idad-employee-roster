import assert from "node:assert/strict";
const origin = process.env.PORTAL_TEST_URL || "http://127.0.0.1:3211";
assert.equal(new URL(origin).hostname, "127.0.0.1");
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  requestOrigin = origin,
) {
  return fetch(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      ...(body
        ? { "Content-Type": "application/json", origin: requestOrigin }
        : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
assert.equal(
  (await (await call("login-options")).json()).demo,
  true,
  "Fictional demo storage only",
);
async function login(accountId: string, code: string) {
  const r = await call("login", "POST", { accountId, code });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const admin = await login("IDADadmin", "demo-admin"),
  manager = await login("TX-DEMO-2", "demo-store");
try {
  assert.equal((await call("admin/people")).status, 401);
  for (const endpoint of ["admin/people", "admin/people/migration-preview"])
    assert.equal((await call(endpoint, "GET", undefined, manager)).status, 403);
  const token = crypto.randomUUID();
  const input = {
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: token,
    posName: "Multi Store Fixture",
    firstName: "Multi",
    lastName: `Fixture ${token}`,
    preferredName: "",
    aliases: [],
    status: "active",
  };
  const create = await call("employees", "POST", input, admin);
  assert.equal(create.status, 200);
  const employee = await create.json();
  const all = await (
    await call("admin/people", "GET", undefined, admin)
  ).json();
  const profile = all.find((p: { id: string }) => p.id === employee.id);
  const payload = {
    revision: profile.revision,
    firstName: profile.firstName,
    lastName: profile.lastName,
    preferredName: "",
    homeStoreId: "TX-DEMO-1",
    multiStore: true,
    assignments: [
      { storeId: "TX-DEMO-1", status: "active" },
      { storeId: "TX-DEMO-2", status: "active" },
    ],
  };
  assert.equal(
    (await call(`admin/people/${profile.id}`, "PATCH", payload, manager))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `admin/people/${profile.id}`,
        "PATCH",
        payload,
        admin,
        "https://invalid.example",
      )
    ).status,
    403,
  );
  const save = await call(
    `admin/people/${profile.id}`,
    "PATCH",
    payload,
    admin,
  );
  assert.equal(save.status, 200);
  const updated = await save.json();
  assert.equal(updated.assignments.length, 2);
  assert.equal(
    (await call(`admin/people/${profile.id}`, "PATCH", payload, admin)).status,
    409,
  );
  const roster = await (
    await call("roster?storeId=TX-DEMO-2", "GET", undefined, manager)
  ).json();
  const pending = roster.employees.find(
    (e: { personId?: string }) => e.personId === profile.id,
  );
  assert.ok(pending);
  assert.equal(pending.posEmployeeId, "");
  assert.equal(pending.posIdentityPending, true);
  const edit = {
    ...input,
    posName: pending.posName,
    storeId: "TX-DEMO-2",
    posEmployeeId: "",
    status: "inactive",
    revision: pending.revision,
  };
  assert.equal(
    (await call(`employees/${pending.id}`, "PATCH", edit, manager)).status,
    200,
  );
  const reread = await (
    await call("admin/people", "GET", undefined, admin)
  ).json();
  const retained = reread.find((p: { id: string }) => p.id === profile.id);
  assert.equal(
    retained.assignments.find(
      (e: { storeId: string }) => e.storeId === "TX-DEMO-1",
    ).status,
    "active",
  );
  const off = {
    ...payload,
    revision: retained.revision,
    multiStore: false,
    assignments: retained.assignments.map((e: { storeId: string }) => ({
      storeId: e.storeId,
      status: "inactive",
    })),
  };
  assert.equal(
    (await call(`admin/people/${profile.id}`, "PATCH", off, admin)).status,
    200,
  );
  console.log(
    "PASS: admin-only profiles, origin denial, persistent assignments, stale revision, pending roster identity, manager-local deactivation and retained history.",
  );
} finally {
  await call("logout", "POST", {}, admin);
  await call("logout", "POST", {}, manager);
}
