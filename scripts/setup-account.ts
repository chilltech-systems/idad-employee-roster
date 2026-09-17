import { credential } from "../src/lib/seed";
import { MongoRepository, testDatabase } from "../src/lib/repository";
import { stores } from "../src/lib/config";
const accountId = process.env.PORTAL_SETUP_ACCOUNT;
const code = process.env.PORTAL_SETUP_CODE;
testDatabase();
if (!accountId || !code)
  throw new Error(
    "Supply the approved account and code through the process environment, never command arguments.",
  );
if (accountId !== "IDADadmin" && !stores().some((s) => s.id === accountId))
  throw new Error("Account must be an enabled store or IDADadmin.");
await new MongoRepository().transact((s) => {
  if (s.access.some((x) => x.id === accountId))
    throw new Error("Account already exists; use audited admin reset.");
  s.access.push(
    credential(
      accountId,
      accountId === "IDADadmin" ? "admin" : "store",
      code,
      accountId === "IDADadmin" ? undefined : accountId,
    ),
  );
  s.audit.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: "isolated-test-provisioner",
    action: "access.create",
    reason: "Explicit test account setup",
  });
});
console.log("Test account created; no credentials printed.");
process.exit(0);
