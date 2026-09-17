import { z } from "zod";
import { storeSchema } from "./model";
export const demoStores = [
  {
    id: "TX-DEMO-1",
    state: "Texas",
    brand: "Auntie Anne’s",
    name: "Oak Grove · fictional",
    posSource: "Qu",
  },
  {
    id: "TX-DEMO-2",
    state: "Texas",
    brand: "Auntie Anne’s",
    name: "Cedar Park · fictional",
    posSource: "Qu",
  },
];
export function mode() {
  const value = process.env.PORTAL_MODE || "demo";
  if (value === "demo") {
    if (process.env.VERCEL)
      throw new Error("Demo storage cannot run on Vercel.");
    return value;
  }
  if (value === "mongo-production") {
    if (process.env.PORTAL_ENABLE_PRODUCTION_WRITES !== "yes" ||
        process.env.PORTAL_MONGODB_DATABASE !== "employee_directory" ||
        (process.env.VERCEL && process.env.VERCEL_ENV !== "production"))
      throw new Error("The scoped production connection is not enabled.");
    return value;
  }
  if (value !== "mongo-test" || process.env.PORTAL_ENABLE_TEST_WRITES !== "yes")
    throw new Error(
      "Only demo or explicitly enabled isolated test storage is supported.",
    );
  return value;
}
export function stores() {
  return mode() === "demo"
    ? demoStores
    : z
        .array(storeSchema)
        .min(1)
        .parse(JSON.parse(process.env.PORTAL_STORES_JSON || "[]"));
}
export function assertLocalDemo(host: string) {
  if (mode() === "demo" && !["localhost", "127.0.0.1", "[::1]"].includes(host))
    throw new Error("Fictional demo is restricted to localhost.");
}
