import test from "node:test";
import assert from "node:assert/strict";
import { assertStateTransition } from "../src/lib/storage-scope";
import { seed } from "../src/lib/seed";
import { testDatabase } from "../src/lib/repository";
import { mode } from "../src/lib/config";
test("production mode requires exact database and explicit activation, and refuses Preview", () => {
  const saved = { ...process.env };
  try {
    process.env.PORTAL_MODE = "mongo-production";
    process.env.PORTAL_MONGODB_DATABASE = "employee_directory";
    delete process.env.PORTAL_ENABLE_PRODUCTION_WRITES;
    assert.throws(() => mode(), /not enabled/);
    process.env.PORTAL_ENABLE_PRODUCTION_WRITES = "yes";
    delete process.env.VERCEL;
    assert.equal(mode(), "mongo-production");
    assert.throws(() => testDatabase(), /isolated/);
    for (const name of ["DirectoryDB", "employee_directory_test", "admin"]) {
      process.env.PORTAL_MONGODB_DATABASE = name;
      assert.throws(() => mode(), /not enabled/);
    }
    process.env.PORTAL_MONGODB_DATABASE = "employee_directory";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    assert.throws(() => mode(), /not enabled/);
    process.env.VERCEL_ENV = "production";
    assert.equal(mode(), "mongo-production");
  } finally {
    for (const key of ["PORTAL_MODE", "PORTAL_MONGODB_DATABASE", "PORTAL_ENABLE_PRODUCTION_WRITES", "VERCEL", "VERCEL_ENV"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
test("storage refuses deleted employees and edited or removed audit history", () => {
  const before = seed();
  before.audit = [
    { id: "audit-1", at: "2026-09-10", actor: "fixture", action: "create" },
  ];
  const removed = structuredClone(before);
  removed.employees.pop();
  assert.throws(
    () => assertStateTransition(before, removed),
    /cannot be deleted/,
  );
  const edited = structuredClone(before);
  edited.audit[0].actor = "another";
  assert.throws(() => assertStateTransition(before, edited), /immutable/);
  const lost = structuredClone(before);
  lost.audit = [];
  assert.throws(() => assertStateTransition(before, lost), /immutable/);
  const valid = structuredClone(before);
  valid.employees[0].status = "inactive";
  valid.access = [];
  assert.doesNotThrow(() => assertStateTransition(before, valid));
});
test("production database names are rejected before a Mongo client is created", () => {
  const old = { ...process.env };
  try {
    process.env.PORTAL_MODE = "mongo-test";
    process.env.PORTAL_ENABLE_TEST_WRITES = "yes";
    for (const database of [
      "DirectoryDB",
      "employee_directory",
      "ScheduleDB",
      "RawExportDB",
      "admin",
      "employee_directory_test.other",
    ]) {
      process.env.PORTAL_MONGODB_DATABASE = database;
      assert.throws(() => testDatabase(), /isolated/);
    }
    process.env.PORTAL_MONGODB_DATABASE = "employee_directory_test";
    assert.equal(testDatabase(), "employee_directory_test");
  } finally {
    for (const key of [
      "PORTAL_MODE",
      "PORTAL_ENABLE_TEST_WRITES",
      "PORTAL_MONGODB_DATABASE",
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
