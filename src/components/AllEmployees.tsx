"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Store, RosterCandidate, State } from "@/lib/model";
import type { PersonView } from "@/lib/people";
import {
  filterPeople,
  isPersonActive,
  statusAssignments,
  type RosterStatus,
} from "@/lib/people-list";
import {
  scheduleSyncNotice,
  type ScheduleSyncResponse,
} from "@/lib/schedule-sync-result";

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch(`/api/v1/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed.");
  return data;
}
type DraftStatus = {
  configured: boolean;
  automation?: State["sync"]["automation"];
};
const verification = (e: PersonView["assignments"][number]) =>
  e.posIdentityPending
    ? "POS verification pending"
    : {
        confirmed: "POS confirmed",
        awaiting: "Awaiting POS",
        review: "Needs review",
        manual: "Manually verified",
      }[e.verification];
export default function AllEmployees({
  stores,
  initialCandidate,
  onReviewNew,
  onChanged,
}: {
  stores: Store[];
  initialCandidate?: RosterCandidate;
  onReviewNew: (candidate: RosterCandidate) => void;
  onChanged: () => Promise<void>;
}) {
  const [people, setPeople] = useState<PersonView[]>([]),
    [candidates, setCandidates] = useState<RosterCandidate[]>([]),
    [selected, setSelected] = useState<string>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState<RosterStatus>("active"),
    [storeId, setStoreId] = useState(""),
    [selectedStates, setSelectedStates] = useState<string[]>([]),
    [multipleStoresOnly, setMultipleStoresOnly] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [busyProfile, setBusyProfile] = useState<string>(),
    [draft, setDraft] = useState<DraftStatus>();
  const load = useCallback(async () => {
    const [p, c, d] = await Promise.all([
      request<PersonView[]>("admin/people"),
      request<RosterCandidate[]>("candidates"),
      request<DraftStatus>("draft/status"),
    ]);
    setPeople(p);
    setCandidates(c);
    setDraft(d);
    setLoaded(true);
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([
      request<PersonView[]>("admin/people"),
      request<RosterCandidate[]>("candidates"),
      request<DraftStatus>("draft/status"),
    ])
      .then(([p, c, d]) => {
        if (alive) {
          setPeople(p);
          setCandidates(c);
          setDraft(d);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function saved() {
    setSelected(undefined);
    setNotice(
      "Assignments saved. Sync the schedule dropdowns to apply these changes.",
    );
    await Promise.all([load(), onChanged()]);
  }
  async function sync() {
    setBusy(true);
    setError("");
    try {
      const response = await request<ScheduleSyncResponse>(
        "draft/sync",
        "POST",
        {},
      );
      setDraft(await request<DraftStatus>("draft/status"));
      setNotice(scheduleSyncNotice(response));
    } catch (e) {
      setError(
        `Assignments remain saved. Schedule sync failed: ${(e as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function setEmployeeActive(person: PersonView, active: boolean) {
    if (
      !active &&
      !window.confirm(
        `Deactivate ${person.firstName} ${person.lastName} at every assigned store? Their assignments and history will be retained.`,
      )
    )
      return;
    setBusyProfile(person.id);
    setError("");
    setNotice("");
    try {
      await request(`admin/people/${person.id}`, "PATCH", {
        revision: person.revision,
        firstName: person.firstName,
        lastName: person.lastName,
        preferredName: person.preferredName,
        homeStoreId: person.homeStoreId,
        multiStore: person.multiStore,
        assignments: statusAssignments(person, active),
        confirmDeactivateAdditional: false,
      });
      setNotice(
        active
          ? "Employee activated at their home store. Additional stores can be activated in the profile."
          : "Employee deactivated. Assignments and history were retained.",
      );
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyProfile(undefined);
    }
  }
  const profile = people.find((p) => p.id === selected);
  const name = (id: string) =>
    `${id} · ${stores.find((s) => s.id === id)?.name || id}`;
  const states = [...new Set(stores.map((store) => store.state))].sort();
  const storeDetails = new Map(
    stores.map((store) => [
      store.id,
      { state: store.state, label: name(store.id) },
    ]),
  );
  const filteredPeople = filterPeople(people, storeDetails, {
    search,
    status,
    storeId,
    states: selectedStates,
    multipleStoresOnly,
  });
  function toggleState(state: string) {
    setSelectedStates((current) =>
      current.includes(state)
        ? current.filter((item) => item !== state)
        : [...current, state],
    );
  }
  return (
    <>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      <section className="panel card">
        <div className="panel-title">
          <div>
            <h2>Roster & assignments</h2>
            <p className="muted">
              One profile per linked employee, alphabetical by first name. Store
              assignments survive POS refreshes.
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setSelected(undefined);
              load().catch((e) => setError(e.message));
            }}
          >
            Reload roster
          </button>
        </div>
        <div className="panel-title">
          <p className="muted">
            {draft?.configured
              ? `Last schedule sync: ${draft.automation?.lastDraft ? new Date(draft.automation.lastDraft).toLocaleString() : "Not yet synced"}`
              : "Schedule sync is not configured in this environment."}
          </p>
          <button
            className="secondary"
            disabled={busy || !draft?.configured}
            onClick={sync}
          >
            {busy ? "Syncing…" : "Sync schedule dropdowns"}
          </button>
        </div>
        {draft?.automation?.error && (
          <p role="alert">{draft.automation.error}</p>
        )}
        {initialCandidate && !profile && (
          <p className="info-strip">
            Select the existing employee for {initialCandidate.posName} at{" "}
            {initialCandidate.storeId}, then use “Link POS record” below their
            assignments.
          </p>
        )}
        {profile ? (
          <Profile
            key={`${profile.id}:${profile.revision}`}
            profile={profile}
            people={people}
            candidates={candidates}
            stores={stores}
            initialCandidate={initialCandidate}
            onSaved={saved}
            onClose={() => setSelected(undefined)}
          />
        ) : (
          <>
            <div className="roster-filters">
              <label className="roster-search">
                Search full roster
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Employee name or store"
                />
              </label>
              <label>
                Store
                <select
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                >
                  <option value="">All stores</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.id} · {store.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="roster-filter-group">
                <span className="roster-filter-label">Employee status</span>
                <div className="segments" aria-label="Employee status filter">
                  {(["active", "inactive"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={status === value ? "active" : ""}
                      aria-pressed={status === value}
                      onClick={() => setStatus(value)}
                    >
                      {value === "active" ? "Active" : "Inactive"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="roster-filter-group roster-state-filter">
                <span className="roster-filter-label">
                  State <small>Choose one or more</small>
                </span>
                <div className="filter-pills" aria-label="State filter">
                  <button
                    type="button"
                    className={selectedStates.length === 0 ? "selected" : ""}
                    aria-pressed={selectedStates.length === 0}
                    onClick={() => setSelectedStates([])}
                  >
                    All states
                  </button>
                  {states.map((state) => (
                    <button
                      key={state}
                      type="button"
                      className={
                        selectedStates.includes(state) ? "selected" : ""
                      }
                      aria-pressed={selectedStates.includes(state)}
                      onClick={() => toggleState(state)}
                    >
                      {state}
                    </button>
                  ))}
                </div>
              </div>
              <div className="roster-filter-group">
                <span className="roster-filter-label">Assignments</span>
                <button
                  type="button"
                  className={`filter-toggle${multipleStoresOnly ? " selected" : ""}`}
                  aria-pressed={multipleStoresOnly}
                  onClick={() => setMultipleStoresOnly((current) => !current)}
                >
                  Multiple stores
                </button>
              </div>
            </div>
            <p className="roster-results muted" aria-live="polite">
              Showing {filteredPeople.length} {status} employee
              {filteredPeople.length === 1 ? "" : "s"}
            </p>
            <div className="table-wrap people-table">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Home store</th>
                    <th>Additional stores</th>
                    <th>Status / verification</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPeople.map((p) => {
                    const active = isPersonActive(p);
                    return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="text-link employee-link"
                            onClick={() => setSelected(p.id)}
                          >
                            <strong>
                              {p.firstName} {p.lastName}
                            </strong>
                          </button>
                          <small>{p.displayName}</small>
                        </td>
                        <td>{name(p.homeStoreId)}</td>
                        <td>
                          {p.assignments
                            .filter((e) => e.storeId !== p.homeStoreId)
                            .map((e) => (
                              <small key={e.id}>
                                {name(e.storeId)} · {e.status}
                              </small>
                            ))}
                        </td>
                        <td>
                          <label className="employee-status-switch">
                            <input
                              type="checkbox"
                              role="switch"
                              checked={active}
                              disabled={busyProfile === p.id}
                              title={
                                active
                                  ? "Deactivate at every assigned store"
                                  : "Activate at the home store"
                              }
                              onChange={(event) =>
                                void setEmployeeActive(p, event.target.checked)
                              }
                            />
                            <span>{active ? "Active" : "Inactive"}</span>
                          </label>
                          {p.assignments.map((e) => (
                            <small key={e.id}>
                              {e.storeId}: {e.status} · {verification(e)}
                            </small>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!loaded && <p>Loading roster…</p>}
            {loaded && filteredPeople.length === 0 && (
              <p className="empty">No employees match these filters.</p>
            )}
          </>
        )}
      </section>
      {!profile && candidates.length > 0 && (
        <section className="panel card">
          <h2>POS records to review</h2>
          <p>
            Select an existing employee above to link a record, or create a new
            employee below. Matches are never inferred from names alone.
          </p>
          {candidates.map((c) => (
            <div className="panel-title" key={c.id}>
              <span>
                {c.posName} · {name(c.storeId)}
              </span>
              <button className="secondary" onClick={() => onReviewNew(c)}>
                Review as new employee
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
function Profile({
  profile,
  people,
  candidates,
  stores,
  initialCandidate,
  onSaved,
  onClose,
}: {
  profile: PersonView;
  people: PersonView[];
  candidates: RosterCandidate[];
  stores: Store[];
  initialCandidate?: RosterCandidate;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [first, setFirst] = useState(profile.firstName),
    [last, setLast] = useState(profile.lastName),
    [preferred, setPreferred] = useState(profile.preferredName),
    [home, setHome] = useState(profile.homeStoreId),
    [multi, setMulti] = useState(profile.multiStore),
    [statuses, setStatuses] = useState<Record<string, "active" | "inactive">>(
      Object.fromEntries(profile.assignments.map((e) => [e.storeId, e.status])),
    ),
    [confirmOff, setConfirmOff] = useState(false),
    [otherId, setOtherId] = useState(""),
    [linkHome, setLinkHome] = useState(""),
    [confirmLink, setConfirmLink] = useState(false),
    [candidateId, setCandidateId] = useState(initialCandidate?.id || ""),
    [confirmPOS, setConfirmPOS] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const other = people.find((p) => p.id === otherId),
    candidate = candidates.find((c) => c.id === candidateId);
  const deactivate =
    profile.multiStore &&
    !multi &&
    profile.assignments.some(
      (e) => e.storeId !== home && e.status === "active",
    );
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() =>
      request(`admin/people/${profile.id}`, "PATCH", {
        revision: profile.revision,
        firstName: first,
        lastName: last,
        preferredName: preferred,
        homeStoreId: home,
        multiStore: multi,
        assignments: Object.entries(statuses).map(([storeId, status]) => ({
          storeId,
          status: !multi && storeId !== home ? "inactive" : status,
        })),
        confirmDeactivateAdditional: confirmOff,
      }),
    );
  }
  return (
    <>
      <button className="text-link back" disabled={busy} onClick={onClose}>
        ← All employees
      </button>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="profile-fields">
          <legend>Employee profile</legend>
          <div className="form-grid">
            <label>
              First name
              <input
                required
                maxLength={80}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            </label>
            <label>
              Last name
              <input
                required
                maxLength={80}
                value={last}
                onChange={(e) => setLast(e.target.value)}
              />
            </label>
            <label>
              Preferred schedule name
              <input
                maxLength={100}
                value={preferred}
                onChange={(e) => setPreferred(e.target.value)}
              />
            </label>
            <label>
              Home store
              <select
                value={home}
                onChange={(e) => {
                  setHome(e.target.value);
                  setStatuses((x) => ({
                    ...x,
                    [e.target.value]: x[e.target.value] || "active",
                  }));
                  setConfirmOff(false);
                }}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="full check-label">
              <input
                type="checkbox"
                checked={multi}
                onChange={(e) => {
                  setMulti(e.target.checked);
                  setConfirmOff(false);
                }}
              />
              Multi-store employee
            </label>
          </div>
          <h3>Store assignments</h3>
          <p className="muted">
            Unchecked stores become inactive. Prior schedules and reporting
            history are retained.
          </p>
          {stores.map((s) => {
            const e = profile.assignments.find((e) => e.storeId === s.id);
            return (
              <div className="assignment-row" key={s.id}>
                <label className="check-label">
                  <input
                    type="checkbox"
                    aria-label={`Active at ${s.id}`}
                    checked={
                      statuses[s.id] === "active" && (multi || home === s.id)
                    }
                    disabled={!multi && home !== s.id}
                    onChange={(event) =>
                      setStatuses((x) => ({
                        ...x,
                        [s.id]: event.target.checked ? "active" : "inactive",
                      }))
                    }
                  />
                  {s.id} · {s.name}
                  {home === s.id ? " · Home" : ""}
                </label>
                <small>
                  {e
                    ? verification(e)
                    : "POS verification pending when assigned"}
                </small>
              </div>
            );
          })}
          {deactivate && (
            <label className="check-label">
              <input
                type="checkbox"
                required
                checked={confirmOff}
                onChange={(e) => setConfirmOff(e.target.checked)}
              />
              Confirm: deactivate all additional stores and retain their
              history.
            </label>
          )}
          <p>
            <button
              className="primary"
              disabled={busy || (deactivate && !confirmOff)}
            >
              {busy ? "Saving…" : "Save profile & assignments"}
            </button>
          </p>
        </fieldset>
      </form>
      <hr />
      <h3>Link an existing employee profile</h3>
      <p className="muted">
        Use this when the same person already exists at another store. Save
        profile changes above first. Shared-store conflicts are blocked for
        review.
      </p>
      <label>
        Existing profile
        <select
          disabled={busy}
          value={otherId}
          onChange={(e) => {
            setOtherId(e.target.value);
            setLinkHome("");
            setConfirmLink(false);
          }}
        >
          <option value="">Choose an employee…</option>
          {people
            .filter((p) => p.id !== profile.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName} ·{" "}
                {p.assignments.map((e) => e.storeId).join(", ")}
              </option>
            ))}
        </select>
      </label>
      {other && (
        <>
          <p>
            {profile.firstName} {profile.lastName} (
            {profile.assignments.map((e) => e.storeId).join(", ")}) ↔{" "}
            {other.firstName} {other.lastName} (
            {other.assignments.map((e) => e.storeId).join(", ")})
          </p>
          <label>
            Home store for linked employee
            <select
              disabled={busy}
              value={linkHome}
              onChange={(e) => setLinkHome(e.target.value)}
            >
              <option value="">Choose explicitly…</option>
              {[
                ...new Set(
                  [...profile.assignments, ...other.assignments].map(
                    (e) => e.storeId,
                  ),
                ),
              ].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label className="check-label">
            <input
              disabled={busy}
              type="checkbox"
              checked={confirmLink}
              onChange={(e) => setConfirmLink(e.target.checked)}
            />
            I confirm these records belong to the same person.
          </label>
          <button
            className="secondary"
            disabled={busy || !confirmLink || !linkHome}
            onClick={() =>
              run(() =>
                request(`admin/people/${profile.id}/link`, "POST", {
                  revision: profile.revision,
                  otherId,
                  otherRevision: other.revision,
                  homeStoreId: linkHome,
                  confirmed: true,
                }),
              )
            }
          >
            Link profiles
          </button>
        </>
      )}
      <hr />
      <h3>Link POS record</h3>
      <p className="muted">
        Connect a reviewed clock-in identity to this employee. An inactive
        assignment stays inactive.
      </p>
      <label>
        POS record to review
        <select
          disabled={busy}
          value={candidateId}
          onChange={(e) => {
            setCandidateId(e.target.value);
            setConfirmPOS(false);
          }}
        >
          <option value="">Choose a POS record…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.storeId} · {c.posName} · {c.posEmployeeId}
            </option>
          ))}
        </select>
      </label>
      {candidate && (
        <>
          <label className="check-label">
            <input
              disabled={busy}
              type="checkbox"
              checked={confirmPOS}
              onChange={(e) => setConfirmPOS(e.target.checked)}
            />
            This POS record belongs to {profile.firstName} {profile.lastName} at{" "}
            {candidate.storeId}.
          </label>
          <button
            className="secondary"
            disabled={busy || !confirmPOS}
            onClick={() =>
              run(() =>
                request(`admin/people/${profile.id}/candidate`, "POST", {
                  revision: profile.revision,
                  candidateId,
                  posEmployeeId: candidate.posEmployeeId,
                  posName: candidate.posName,
                  confirmed: true,
                }),
              )
            }
          >
            Link POS record
          </button>
        </>
      )}
    </>
  );
}
