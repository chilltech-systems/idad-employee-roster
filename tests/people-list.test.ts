import test from "node:test";
import assert from "node:assert/strict";
import {
  filterPeople,
  isPersonActive,
  statusAssignments,
  type RosterPerson,
} from "../src/lib/people-list";

const people: RosterPerson[] = [
  {
    id: "one",
    firstName: "Alex",
    lastName: "Rivera",
    displayName: "Alex R.",
    homeStoreId: "TX-1",
    multiStore: true,
    assignments: [
      { storeId: "TX-1", status: "active" },
      { storeId: "CO-1", status: "inactive" },
    ],
  },
  {
    id: "two",
    firstName: "Blair",
    lastName: "Stone",
    displayName: "Blair S.",
    homeStoreId: "CO-1",
    multiStore: false,
    assignments: [{ storeId: "CO-1", status: "inactive" }],
  },
  {
    id: "three",
    firstName: "Casey",
    lastName: "Wells",
    displayName: "Casey W.",
    homeStoreId: "TX-2",
    multiStore: false,
    assignments: [{ storeId: "TX-2", status: "active" }],
  },
];
const stores = new Map([
  ["TX-1", { state: "Texas", label: "TX-1 · Baybrook" }],
  ["TX-2", { state: "Texas", label: "TX-2 · Woodlands" }],
  ["CO-1", { state: "Colorado", label: "CO-1 · Denver" }],
]);

test("roster filters active/inactive, store, multi-store and multi-state selections", () => {
  assert.deepEqual(
    filterPeople(people, stores, {
      search: "",
      status: "active",
      storeId: "",
      states: [],
      multipleStoresOnly: false,
    }).map((person) => person.id),
    ["one", "three"],
  );
  assert.deepEqual(
    filterPeople(people, stores, {
      search: "",
      status: "inactive",
      storeId: "",
      states: ["Colorado", "Texas"],
      multipleStoresOnly: false,
    }).map((person) => person.id),
    ["two"],
  );
  assert.deepEqual(
    filterPeople(people, stores, {
      search: "alex",
      status: "active",
      storeId: "CO-1",
      states: ["Texas", "Colorado"],
      multipleStoresOnly: true,
    }).map((person) => person.id),
    ["one"],
  );
});

test("status controls retain assignments while changing the intended stores", () => {
  assert.equal(isPersonActive(people[0]), true);
  assert.deepEqual(statusAssignments(people[0], false), [
    { storeId: "TX-1", status: "inactive" },
    { storeId: "CO-1", status: "inactive" },
  ]);
  assert.deepEqual(statusAssignments(people[0], true), [
    { storeId: "TX-1", status: "active" },
    { storeId: "CO-1", status: "inactive" },
  ]);
  assert.deepEqual(
    statusAssignments({ ...people[0], multiStore: false }, true),
    [
      { storeId: "TX-1", status: "active" },
      { storeId: "CO-1", status: "inactive" },
    ],
  );
});
