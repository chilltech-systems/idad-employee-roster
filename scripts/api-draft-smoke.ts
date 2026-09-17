import assert from "node:assert/strict";
const origin = process.env.PORTAL_TEST_URL || "http://127.0.0.1:3211";
assert.equal(new URL(origin).hostname, "127.0.0.1");
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
) {
  return fetch(origin + "/api/v1/" + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json", origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
assert.equal(
  (await (await call("login-options")).json()).demo,
  true,
  "This smoke check only writes fictional demo storage",
);
async function signIn(accountId: string, code: string) {
  const r = await call("login", "POST", { accountId, code });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const manager = await signIn("TX-DEMO-1", "demo-store"),
  admin = await signIn("IDADadmin", "demo-admin");
try {
  assert.equal(
    (await call("candidates?storeId=TX-DEMO-2", "GET", undefined, manager))
      .status,
    403,
  );
  assert.equal((await call("draft/sync", "POST", {}, manager)).status, 403);
  assert.equal(
    (await call("draft/export", "POST", { storeId: "TX-DEMO-2" }, manager))
      .status,
    403,
  );
  assert.equal(
    (await call("draft/export", "POST", { storeId: "TX-DEMO-1" }, manager))
      .status,
    503,
  );
  assert.equal(
    (await (await call("draft/status", "GET", undefined, manager)).json())
      .configured,
    false,
  );
  const existing = await (
    await call("employees", "GET", undefined, admin)
  ).json();
  const identity = "DISCOVERY-" + crypto.randomUUID();
  const discovered = ["TX-DEMO-1", "TX-DEMO-2"].map((storeId) => ({
    storeId,
    posSource: "Qu",
    posEmployeeId: identity,
    posName: "Fictional New Hire",
  }));
  const rows = [
    ...existing
      .filter((e: any) => !e.posIdentityPending)
      .map((e: any) => ({
        storeId: e.storeId,
        posSource: e.posSource,
        posEmployeeId: e.posEmployeeId,
        posName: e.posName,
      })),
    ...discovered,
  ];
  const snapshot = {
    source: "local-api-fixture",
    observedAt: new Date().toISOString(),
    complete: true,
    stores: ["TX-DEMO-1", "TX-DEMO-2"],
    rowCount: rows.length,
    rows,
  };
  assert.equal(
    (await call("admin/refresh", "POST", snapshot, admin)).status,
    200,
  );
  const candidates = await (
    await call("candidates", "GET", undefined, admin)
  ).json();
  const own = candidates.find(
    (c: any) => c.posEmployeeId === identity && c.storeId === "TX-DEMO-1",
  );
  const other = candidates.find(
    (c: any) => c.posEmployeeId === identity && c.storeId === "TX-DEMO-2",
  );
  assert.ok(own && other);
  assert.equal(
    (await call("admin/refresh", "POST", snapshot, admin)).status,
    200,
  );
  const repeated = await (
    await call("candidates", "GET", undefined, admin)
  ).json();
  assert.equal(
    repeated.filter((c: any) => c.posEmployeeId === identity).length,
    2,
  );
  assert.ok(repeated.some((c: any) => c.id === own.id));
  const employees = await (
    await call("employees", "GET", undefined, admin)
  ).json();
  assert.equal(employees.length, existing.length);
  for (const e of existing)
    assert.equal(employees.find((x: any) => x.id === e.id).status, e.status);
  const body = {
    ...discovered[0],
    firstName: "Fictional",
    lastName: "New Hire",
    preferredName: "Fixture hire",
    aliases: [],
    status: "active",
  };
  assert.equal(
    (await call(`candidates/${other.id}/accept`, "POST", body, manager)).status,
    403,
  );
  const accepted = await call(
    `candidates/${own.id}/accept`,
    "POST",
    body,
    manager,
  );
  assert.equal(accepted.status, 200);
  const e = await accepted.json();
  assert.equal(e.verification, "confirmed");
  assert.equal(
    (await call(`candidates/${own.id}/accept`, "POST", body, manager)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `employees/${e.id}`,
        "PATCH",
        { ...body, status: "inactive", revision: e.revision },
        manager,
      )
    ).status,
    200,
  );
  console.log(
    "PASS: scoped discovery, repeated refresh deduplication, no automatic activation/reactivation, manager acceptance, duplicate/cross-store denial, and draft endpoint authorization. Fictional demo only.",
  );
} finally {
  await call("logout", "POST", {}, manager);
  await call("logout", "POST", {}, admin);
}
