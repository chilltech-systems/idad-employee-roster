import type { PersonView } from "./people";

export type RosterStatus = "active" | "inactive";
type RosterAssignment = Pick<
  PersonView["assignments"][number],
  "storeId" | "status"
>;
export type RosterPerson = Pick<
  PersonView,
  "id" | "firstName" | "lastName" | "displayName" | "homeStoreId" | "multiStore"
> & { assignments: RosterAssignment[] };

export type PeopleFilters = {
  search: string;
  status: RosterStatus;
  storeId: string;
  states: string[];
  multipleStoresOnly: boolean;
};

export const isPersonActive = (person: RosterPerson) =>
  person.assignments.some((assignment) => assignment.status === "active");

export function filterPeople<T extends RosterPerson>(
  people: T[],
  storeDetails: Map<string, { state: string; label: string }>,
  filters: PeopleFilters,
) {
  const query = filters.search.trim().toLocaleLowerCase("en-US");
  const selectedStates = new Set(filters.states);
  return people.filter((person) => {
    if (
      filters.status === "active"
        ? !isPersonActive(person)
        : isPersonActive(person)
    )
      return false;
    if (
      filters.storeId &&
      !person.assignments.some(
        (assignment) => assignment.storeId === filters.storeId,
      )
    )
      return false;
    if (
      selectedStates.size > 0 &&
      !person.assignments.some((assignment) =>
        selectedStates.has(storeDetails.get(assignment.storeId)?.state || ""),
      )
    )
      return false;
    if (filters.multipleStoresOnly && person.assignments.length < 2)
      return false;
    if (
      query &&
      !`${person.firstName} ${person.lastName} ${person.displayName} ${person.assignments
        .map(
          (assignment) =>
            storeDetails.get(assignment.storeId)?.label || assignment.storeId,
        )
        .join(" ")}`
        .toLocaleLowerCase("en-US")
        .includes(query)
    )
      return false;
    return true;
  });
}

export function statusAssignments(
  person: RosterPerson,
  active: boolean,
): Array<{ storeId: string; status: RosterStatus }> {
  return person.assignments.map((assignment) => ({
    storeId: assignment.storeId,
    status:
      active && assignment.storeId === person.homeStoreId
        ? "active"
        : "inactive",
  }));
}
