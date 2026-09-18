import assert from "node:assert/strict";
const origin = process.env.PORTAL_TEST_URL || "http://127.0.0.1:3210";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Smoke tests are local-only.");
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  requestOrigin = origin,
) {
  const response = await fetch(origin + "/api/v1/" + path, {
    method,
    headers: {
      ...(body !== undefined
        ? { "Content-Type": "application/json", origin: requestOrigin }
        : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}
assert.equal((await call("employees")).status, 401);
assert.equal((await call("draft/targets")).status, 401);
assert.equal(
  (
    await call(
      "login",
      "POST",
      { accountId: "IDADadmin", code: "demo-admin" },
      undefined,
      "https://bad.example",
    )
  ).status,
  403,
);
assert.equal(
  (
    await call("login", "POST", {
      accountId: "TX-DEMO-1",
      code: "demo-store",
    })
  ).status,
  401,
);
const signed = await call("login", "POST", {
  accountId: "IDADadmin",
  code: "demo-admin",
});
assert.equal(signed.status, 200);
const header = signed.headers.get("set-cookie")!;
assert.match(header, /HttpOnly/i);
assert.match(header, /SameSite=strict/i);
const cookie = header.split(";")[0];
const targetResponse = await call("draft/targets", "GET", undefined, cookie);
assert.equal(targetResponse.status, 200);
const targets = await targetResponse.json();
assert.deepEqual(
  targets.states.texas.options.map(
    (target: { targetKey: string }) => target.targetKey,
  ),
  ["test-current-draft"],
);
assert.deepEqual(
  targets.states.california.options.map(
    (target: { targetKey: string }) => target.targetKey,
  ),
  ["test-current-draft"],
);
const records = await (
  await call("employees", "GET", undefined, cookie)
).json();
assert.equal(
  (await call("employees?storeId=TX-DEMO-2", "GET", undefined, cookie)).status,
  200,
);
assert.equal(
  (await call("roster.csv?storeId=TX-DEMO-2", "GET", undefined, cookie)).status,
  200,
);
assert.ok(records.some((e: { storeId: string }) => e.storeId === "TX-DEMO-1"));
assert.ok(records.some((e: { storeId: string }) => e.storeId === "TX-DEMO-2"));
const own = await call(
  "roster.csv?storeId=TX-DEMO-1",
  "GET",
  undefined,
  cookie,
);
assert.equal(own.status, 200);
assert.match(await own.text(), /Store ID/);
const newEmployee = await call(
  "employees",
  "POST",
  {
    storeId: "TX-DEMO-1",
    posSource: "Qu",
    posEmployeeId: "TEST-" + crypto.randomUUID(),
    posName: "Rowan Test",
    firstName: "Rowan",
    lastName: "Test",
  },
  cookie,
);
assert.equal(newEmployee.status, 200);
const employee = await newEmployee.json();
assert.equal(employee.verification, "awaiting");
const input = {
  workbookId: "smoke",
  weekStart: "2026-09-06",
  revision: 1,
  cells: [
    {
      sheet: "demo",
      row: 1,
      slot: "a",
      storeId: "TX-DEMO-1",
      directoryId: employee.id,
      businessDate: "2026-09-07",
      start: "09:00",
      end: "15:00",
    },
  ],
};
const exported = await call(
  "shifts/validate",
  "POST",
  { storeId: "TX-DEMO-1", input },
  cookie,
);
assert.equal(exported.status, 200);
const snapshot = await exported.json();
assert.equal(snapshot.valid, 1);
assert.equal(snapshot.shifts[0].posEmployeeId, employee.posEmployeeId);
const preview = await call(
  "labor/preview",
  "POST",
  {
    storeId: "TX-DEMO-1",
    input,
    punches: [
      {
        id: "smoke-punch",
        storeId: "TX-DEMO-1",
        posSource: "Qu",
        posEmployeeId: employee.posEmployeeId,
        businessDate: "2026-09-07",
        start: "2026-09-07T09:03:00-05:00",
        end: "2026-09-07T15:02:00-05:00",
      },
    ],
  },
  cookie,
);
assert.equal(preview.status, 200);
assert.equal((await preview.json()).records[0].result, "matched");
// Retain test identity history but remove it from active rosters.
await call(
  "employees/" + employee.id,
  "PATCH",
  {
    storeId: employee.storeId,
    posSource: employee.posSource,
    posEmployeeId: employee.posEmployeeId,
    posName: employee.posName,
    firstName: employee.firstName,
    lastName: employee.lastName,
    status: "inactive",
    revision: employee.revision,
  },
  cookie,
);
assert.equal((await call("logout", "POST", {}, cookie)).status, 200);
assert.equal((await call("employees", "GET", undefined, cookie)).status, 401);
console.log(
  "PASS: retired store-profile denial, IDAD Admin all-store access, admin-only schedule-target listing, origin check, secure session cookie, employee -> roster identity -> shift -> labor preview, and logout revocation.",
);
