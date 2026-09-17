import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { MongoClient, type Document } from "mongodb";
import type { State } from "./model";
import { seed } from "./seed";
import { mode } from "./config";
import { assertStateTransition, PORTAL_COLLECTIONS } from "./storage-scope";
export interface Repository {
  transact<T>(fn: (state: State) => T | Promise<T>): Promise<T>;
}
export class FileRepository implements Repository {
  constructor(private file = path.join(process.cwd(), ".data", "demo.json")) {}
  async transact<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = this.file + ".lock";
    let handle;
    for (let i = 0; i < 100; i++) {
      try {
        handle = await open(lock, "wx", 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!handle) throw new Error("Local storage is busy. Retry shortly.");
    try {
      let state: State;
      try {
        state = JSON.parse(await readFile(this.file, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = seed();
      }
      const before = structuredClone(state);
      const result = await fn(state);
      assertStateTransition(before, state);
      const temp = this.file + ".tmp";
      const output = await open(temp, "w", 0o600);
      try {
        await output.writeFile(JSON.stringify(state));
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temp, this.file);
      return result;
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
}
let mongo: MongoClient | undefined;
export function testDatabase() {
  const name = process.env.PORTAL_MONGODB_DATABASE || "";
  if (!/^employee_directory_test(?:_[a-z0-9]+)?$/.test(name))
    throw new Error(
      "An isolated employee_directory_test database is required.",
    );
  if (mode() !== "mongo-test") throw new Error("Mongo test mode required.");
  return name;
}
export async function mongoConnection() {
  const production = mode() === "mongo-production";
  const name = production ? "employee_directory" : testDatabase();
  const uri = process.env.PORTAL_MONGODB_URI;
  if (!uri) throw new Error("Database connection is not configured.");
  mongo ??= new MongoClient(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });
  if (production && mongo.options.credentials?.username !== "idad_employee_directory_prod_app")
    throw new Error("Dedicated production runtime credential required.");
  await mongo.connect();
  return { client: mongo, db: mongo.db(name) };
}
export class MongoRepository implements Repository {
  async transact<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const { client, db } = await mongoConnection();
    const collections = [
      PORTAL_COLLECTIONS.employees,
      PORTAL_COLLECTIONS.access,
      PORTAL_COLLECTIONS.audit,
      PORTAL_COLLECTIONS.sync,
    ];
    const existing = await db.listCollections().toArray();
    if (collections.some((n) => !existing.some((c) => c.name === n)))
      throw new Error(
        "Reviewed portal storage must exist before connecting.",
      );
    const session = client.startSession();
    try {
      return (await session.withTransaction(async () => {
        const options = { session };
        const clean = (rows: Document[]) =>
          rows.map(({ _id, ...rest }) => rest);
        const employees = clean(
          await db.collection(collections[0]).find({}, options).toArray(),
        );
        const access = clean(
          await db.collection(collections[1]).find({}, options).toArray(),
        );
        const audit = clean(
          await db.collection(collections[2]).find({}, options).toArray(),
        );
        const sync = await db
          .collection(collections[3])
          .findOne({ _id: "state" as never }, options);
        if (!sync) throw new Error("Storage version record is missing.");
        const state = { employees, access, audit, sync: sync.value } as State;
        const before = structuredClone(state);
        const result = await fn(state);
        assertStateTransition(before, state);
        if (JSON.stringify(state) === JSON.stringify(before)) return result;
        // The shared version update serializes authorization, credential resets and employee edits.
        const version = before.sync.version;
        state.sync.version = version + 1;
        const changed = await db
          .collection(collections[3])
          .updateOne(
            { _id: "state" as never, "value.version": version },
            { $set: { value: state.sync } },
            options,
          );
        if (changed.modifiedCount !== 1)
          throw new Error("Concurrent transaction; retry.");
        for (const [key, name] of [
          ["employees", collections[0]],
          ["access", collections[1]],
          ["audit", collections[2]],
        ] as const) {
          const old = new Map(
            before[key].map((x) => [x.id, JSON.stringify(x)]),
          );
          for (const row of state[key]) {
            if (!old.has(row.id)) {
              await db
                .collection(name)
                .insertOne({ ...row, _id: row.id as never }, options);
            } else if (old.get(row.id) !== JSON.stringify(row)) {
              if (key === "audit")
                throw new Error("Existing audit records are immutable.");
              await db
                .collection(name)
                .replaceOne(
                  { _id: row.id as never },
                  { ...row, _id: row.id as never },
                  options,
                );
            }
          }
          // Only expired/revoked access records can be removed. Employee and audit
          // collections never need REMOVE permission on the MongoDB account.
          if (key === "access") {
            const remaining = new Set(state.access.map((row) => row.id));
            for (const row of before.access) {
              if (!remaining.has(row.id))
                await db
                  .collection(PORTAL_COLLECTIONS.access)
                  .deleteOne({ _id: row.id as never }, options);
            }
          }
        }
        return result;
      })) as T;
    } finally {
      await session.endSession();
    }
  }
}
export const repository = (): Repository =>
  mode() === "demo" ? new FileRepository() : new MongoRepository();
