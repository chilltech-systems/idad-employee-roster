import { mongoConnection, testDatabase } from "../src/lib/repository";
const collections: {
  name: string;
  required: string[];
  indexes: { key: Record<string, 1 | -1>; unique?: boolean }[];
}[] = [
  {
    name: "employees",
    required: [
      "id",
      "storeId",
      "posSource",
      "posEmployeeId",
      "revision",
      "status",
      "verification",
    ],
    indexes: [
      { key: { id: 1 }, unique: true },
      { key: { storeId: 1, posSource: 1, posEmployeeId: 1 }, unique: true },
      { key: { storeId: 1, status: 1 } },
    ],
  },
  {
    name: "employee_directory_access",
    required: ["id", "kind"],
    indexes: [{ key: { id: 1 }, unique: true }, { key: { accountId: 1 } }],
  },
  {
    name: "employee_directory_audit",
    required: ["id", "at", "actor", "action"],
    indexes: [
      { key: { id: 1 }, unique: true },
      { key: { storeId: 1, at: -1 } },
    ],
  },
  { name: "employee_directory_sync", required: ["value"], indexes: [] },
];
const plan = {
  database: "employee_directory_test (or approved suffixed test database)",
  operations: collections,
  initialRecord: {
    collection: "employee_directory_sync",
    _id: "state",
    value: { version: 0 },
  },
  productionExecutable: false,
};
if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (
  process.env.PORTAL_TEST_PROVISION_CONFIRM !== "CREATE_EMPTY_TEST_COLLECTIONS"
)
  throw new Error(
    "Review db:plan and set the explicit isolated-test provisioning confirmation first.",
  );
const { client, db } = await mongoConnection();
try {
  const existing = await db.listCollections().toArray();
  if (existing.length)
    throw new Error(
      "Provisioning requires an empty isolated test database. Existing collections are never altered.",
    );
  for (const c of collections) {
    await db.createCollection(c.name, {
      validator: { $jsonSchema: { bsonType: "object", required: c.required } },
      validationAction: "error",
    });
    for (const index of c.indexes)
      await db.collection(c.name).createIndex(index.key, {
        unique: "unique" in index ? index.unique : false,
      });
  }
  await db
    .collection("employee_directory_sync")
    .insertOne({ _id: "state" as never, value: { version: 0 } });
  console.log(
    `Created empty portal collections in ${testDatabase()}. No employee or account data seeded.`,
  );
} finally {
  await client.close();
}
