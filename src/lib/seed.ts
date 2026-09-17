import { randomBytes, scryptSync } from "node:crypto";
import type { Access, Employee, State } from "./model";
export function credential(
  id: string,
  role: "store" | "admin",
  code: string,
  storeId?: string,
): Access {
  const salt = randomBytes(16).toString("hex");
  return {
    id,
    kind: "credential",
    account: { id, role, ...(storeId ? { storeId } : {}) },
    salt,
    hash: scryptSync(code, salt, 64).toString("hex"),
  };
}
export function seed(): State {
  const at = "2026-09-06T12:00:00.000Z";
  const names = [
    ["Maya", "Bennett", "Maya Bennett", "confirmed", ""],
    ["Jordan", "Reed", "Jordan Reed", "awaiting", ""],
    ["Alex", "Rivera", "Alexis Rivera", "review", "Alex R."],
    ["Sam", "Chen", "Sam Chen", "confirmed", ""],
    ["Morgan", "Ellis", "Morgan Ellis", "awaiting", ""],
    ["Taylor", "Brooks", "Taylor Brooks", "confirmed", ""],
  ];
  const employees = names.map(
    ([firstName, lastName, posName, verification, preferredName], i) => ({
      id: `demo-${i + 1}`,
      storeId: "TX-DEMO-1",
      state: "Texas",
      brand: "Auntie Anne’s",
      posSource: "Qu",
      posEmployeeId: `00${101 + i}`,
      posName,
      firstName,
      lastName,
      preferredName,
      aliases: [],
      status: i === 5 ? "inactive" : "active",
      verification,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: "fixture",
      ...(verification === "confirmed"
        ? { observedPosName: posName, observedAt: at }
        : {}),
      ...(verification === "review"
        ? { observedPosName: "Alex Rivera", observedAt: at }
        : {}),
    }),
  ) as Employee[];
  employees.push({
    ...employees[0],
    id: "demo-7",
    storeId: "TX-DEMO-2",
    posEmployeeId: "00901",
    firstName: "Casey",
    lastName: "Lane",
    posName: "Casey Lane",
    observedPosName: "Casey Lane",
  });
  return {
    employees,
    access: [credential("IDADadmin", "admin", "demo-admin")],
    audit: [],
    sync: { version: 0 },
  };
}
