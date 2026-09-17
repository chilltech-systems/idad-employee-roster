import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGoogleRoster,
  readGoogleRoster,
  rosterSpreadsheet,
} from "../src/lib/google-roster";
const stores = [
  {
    id: "TX-200",
    posSource: "Qu",
    state: "Texas",
    brand: "Auntie Anne’s",
    name: "Fixture",
  },
];
const header = ["Store Id", "Employee Name", "Employee Number", "Store+Emp.ID"];
const values = [
  header,
  ["tx-200", "Fictional Employee", "00123", "tx-200+00123"],
  ["hi-201", "Other Fixture", "009", "hi-201+009"],
];
const at = "2026-09-10T12:00:00.000Z";
test("maps explicit stores across states, preserves text IDs and excludes disabled stores", () => {
  const result = parseGoogleRoster(values, stores, at);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].posEmployeeId, "00123");
  assert.equal(result.rows[0].storeId, "TX-200");
  assert.equal(result.observedAt, at);
  const colorado = {
    id: "TJ-1031",
    posSource: "Qu",
    state: "Colorado",
    brand: "Taco John's",
    name: "Horsetooth",
  };
  const multiState = parseGoogleRoster(
    [header, values[1], ["tj-1031", "Other Fixture", "009", "tj-1031+009"]],
    [...stores, colorado],
    at,
  );
  assert.equal(multiState.rowCount, 2);
  assert.equal(multiState.rows[1].storeId, "TJ-1031");
});
test("rejects incomplete, duplicate, changed-column, numeric-ID and missing-store sources", () => {
  for (const data of [
    [],
    [header],
    [header, values[1], values[1]],
    [["wrong"], values[1]],
    [header, ["tx-200", "Fixture", 123, "tx-200+123"]],
    [header, ["tx-200", "Fixture", "123", "tx-200+456"]],
    [header, ["tx-200", "#REF!", "123", "tx-200+123"]],
    [header, values[2]],
  ])
    assert.throws(() => parseGoogleRoster(data, stores, at));
  assert.throws(() =>
    parseGoogleRoster(values, [{ ...stores[0], posSource: "Other POS" }], at),
  );
});
test("linked stores retain separate assignments; no implicit expansion", () => {
  const data = [
    header,
    values[1],
    ["tx-154", "Fictional Employee", "00123", "tx-154+00123"],
  ];
  assert.equal(parseGoogleRoster(data, stores, at).rowCount, 1);
  assert.equal(
    parseGoogleRoster(data, [...stores, { ...stores[0], id: "TX-154" }], at)
      .rowCount,
    2,
  );
});
test("Google transport uses readonly scope, fixed source, GETs and detects changing reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portal-google-test-"));
  const previous = process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE;
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(dir, "fixture.json");
    await writeFile(
      file,
      JSON.stringify({
        type: "service_account",
        client_email: "fixture@example.invalid",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
      { mode: 0o600 },
    );
    process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE = file;
    let reads = 0;
    const request = (async (
      url: string | URL | Request,
      options?: RequestInit,
    ) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        const assertion = (options!.body as URLSearchParams).get("assertion")!;
        const claims = JSON.parse(
          Buffer.from(assertion.split(".")[1], "base64url").toString(),
        );
        assert.equal(
          claims.scope,
          "https://www.googleapis.com/auth/spreadsheets.readonly",
        );
        return Response.json({ access_token: "fictional-token" });
      }
      assert.equal(options?.method, "GET");
      assert.ok(String(url).includes(rosterSpreadsheet));
      assert.equal(options?.redirect, "error");
      reads++;
      return Response.json({ values });
    }) as typeof fetch;
    assert.equal((await readGoogleRoster(stores, request)).rowCount, 1);
    assert.equal(reads, 2);
    let counter = 0;
    await assert.rejects(
      readGoogleRoster(stores, (async (url, opts) => {
        if (String(url).includes("oauth2.googleapis.com"))
          return request(url, opts);
        return Response.json({ values: ++counter === 1 ? values : [header] });
      }) as typeof fetch),
      /changed during refresh/,
    );
  } finally {
    if (previous === undefined)
      delete process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE;
    else process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
