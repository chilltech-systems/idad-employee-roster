"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Users,
  Search,
  Plus,
  Check,
  ArrowUpRight,
  LogOut,
  RefreshCw,
  Download,
  ShieldCheck,
  Clock3,
  TriangleAlert,
  ChevronRight,
  Building2,
  ArrowLeft,
  ClipboardList,
  Settings2,
  Archive,
  RotateCcw,
} from "lucide-react";
import AllEmployees from "./AllEmployees";
import DraftSchedule from "./DraftSchedule";
import SchedulePreview from "./SchedulePreview";
import type {
  Account,
  Audit,
  Employee,
  Store,
  RosterCandidate,
} from "@/lib/model";
import { ADMIN_ACCOUNT_ID } from "@/lib/model";
type Row = Employee & { displayName: string };
type CandidateRow = RosterCandidate & { inCurrentRoster: boolean };
type Sync = {
  lastSuccess?: string;
  lastAttempt?: string;
  error?: string;
  source?: string;
  observedAt?: string;
};
const labels = {
  awaiting: "Awaiting POS",
  confirmed: "POS confirmed",
  review: "Needs review",
  manual: "Manually verified",
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Unable to complete request.");
  return data;
}
function Badge({ value }: { value: Employee["verification"] }) {
  const Icon =
    value === "awaiting"
      ? Clock3
      : value === "review"
        ? TriangleAlert
        : ShieldCheck;
  return (
    <span className={`badge ${value}`}>
      <Icon size={14} />
      {labels[value]}
    </span>
  );
}
export default function Portal() {
  const loadVersion = useRef(0);
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [archivedCandidates, setArchivedCandidates] = useState<CandidateRow[]>(
    [],
  );
  const [selectedCandidate, setSelectedCandidate] = useState<
    RosterCandidate | undefined
  >();
  const [account, setAccount] = useState<Account | null>(null),
    [allStores, setAllStores] = useState<Store[]>([]),
    [storeId, setStoreId] = useState(""),
    [demo, setDemo] = useState(false),
    [production, setProduction] = useState(false),
    [starting, setStarting] = useState(true);
  const [rows, setRows] = useState<Row[]>([]),
    [sync, setSync] = useState<Sync>({}),
    [audit, setAudit] = useState<Audit[]>([]),
    [view, setView] = useState("employees"),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("active"),
    [editor, setEditor] = useState<Row | "new" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [busyCandidate, setBusyCandidate] = useState<string>(),
    [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  useEffect(() => {
    async function init() {
      try {
        const options = await api<{
          stores: Store[];
          demo: boolean;
          production: boolean;
        }>("login-options");
        setAllStores(options.stores);
        setDemo(options.demo);
        setProduction(options.production === true);
        try {
          const me = await api<{ account: Account }>("me");
          setAccount(me.account);
          const allowed = await api<Store[]>("stores");
          setAllStores(allowed);
          setStoreId(me.account.storeId || allowed[0]?.id || "");
        } catch {
          /* Signed out is an expected initial state. */
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setStarting(false);
      }
    }
    void init();
  }, []);
  const load = useCallback(async () => {
    if (!account || !storeId) return;
    const version = ++loadVersion.current;
    setLoaded(false);
    try {
      const allStoreReview = account.role === "admin" && view === "review";
      const [employees, info, history, discoveries, archived] =
        await Promise.all([
          api<Row[]>(
            allStoreReview
              ? "employees"
              : "employees?storeId=" + encodeURIComponent(storeId),
          ),
          api<Sync>("sync"),
          api<Audit[]>("audit"),
          api<CandidateRow[]>(
            allStoreReview
              ? "candidates"
              : "candidates?storeId=" + encodeURIComponent(storeId),
          ),
          allStoreReview
            ? api<CandidateRow[]>("candidates?status=archived")
            : Promise.resolve([] as CandidateRow[]),
        ]);
      if (version !== loadVersion.current) return;
      setRows(employees);
      setCandidates(discoveries);
      setArchivedCandidates(archived);
      setSync(info);
      setAudit(history);
      setLoaded(true);
    } catch (e) {
      if (version !== loadVersion.current) return;
      setRows([]);
      setError((e as Error).message);
    }
  }, [account, storeId, view]);
  useEffect(() => {
    void load();
  }, [load]);
  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ account: Account }>("login", "POST", {
        accountId: ADMIN_ACCOUNT_ID,
        code,
      });
      setAccount(result.account);
      setCode("");
      const allowed = await api<Store[]>("stores");
      setAllStores(allowed);
      setStoreId(result.account.storeId || allowed[0]?.id || "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    try {
      await api("logout", "POST", {});
      loadVersion.current++;
      setAccount(null);
      setRows([]);
      setEditor(null);
      const options = await api<{ stores: Store[] }>("login-options");
      setAllStores(options.stores);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await api("admin/refresh", "POST", {});
      setNotice("Roster checked. Employee preferences preserved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
      setBusy(false);
    }
  }
  async function archiveReview(candidate: CandidateRow) {
    if (
      !window.confirm(
        `Archive the review for ${candidate.posName}? This records that you reviewed it without creating or linking an employee.`,
      )
    )
      return;
    setBusyCandidate(candidate.id);
    setError("");
    setNotice("");
    try {
      await api(`candidates/${candidate.id}/archive`, "POST", {});
      setNotice(
        `${candidate.posName} was archived as reviewed. No employee record was created.`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyCandidate(undefined);
    }
  }
  async function restoreReview(candidate: CandidateRow) {
    setBusyCandidate(candidate.id);
    setError("");
    setNotice("");
    try {
      await api(`candidates/${candidate.id}/restore`, "POST", {});
      setNotice(`${candidate.posName} was returned to Identity Review.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyCandidate(undefined);
    }
  }
  const store = allStores.find((s) => s.id === storeId);
  const visible = rows.filter(
    (e) =>
      (status === "all" || e.status === status) &&
      (view !== "review" || ["awaiting", "review"].includes(e.verification)) &&
      [e.displayName, e.posName, e.posEmployeeId, ...e.aliases]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const active = rows.filter((e) => e.status === "active");
  if (starting)
    return (
      <main className="initial">
        <div className="brand-mark">iD</div>
        <p>Opening employee directory…</p>
      </main>
    );
  if (!account)
    return (
      <main className="login-page">
        <section className="login-story">
          <div className="wordmark">
            <span className="brand-mark">iD</span> IDAD <span>OPERATIONS</span>
          </div>
          <div>
            <span className="eyebrow">PEOPLE & SCHEDULING</span>
            <h1>
              A familiar name.
              <br />A reliable record.
            </h1>
            <p>
              Keep your team’s employee details ready for scheduling and
              accurate labor reports.
            </p>
          </div>
          <span className="story-foot">IDAD Employee Report Directory</span>
        </section>
        <section className="login-form">
          <form onSubmit={signIn}>
            <span className="eyebrow">IDAD EMPLOYEE REPORT DIRECTORY</span>
            <h2>Welcome back</h2>
            <p className="muted">
              Sign in with the IDAD Admin Profile to manage every store.
            </p>
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            <label>
              Profile
              <input value="IDADadmin · All stores" readOnly />
            </label>
            <label>
              Access code
              <input
                type="password"
                autoComplete="current-password"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
              <ArrowUpRight size={18} />
            </button>
            {demo && (
              <div className="demo-note">
                <b>Local demo · fictional employees</b>
                <p>
                  Administrator code: <code>demo-admin</code>
                </p>
              </div>
            )}
          </form>
        </section>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          <span className="brand-mark">iD</span> IDAD <span>OPERATIONS</span>
        </div>
        <div className="workspace-label">TEAM MANAGEMENT</div>
        <nav>
          {[
            ["employees", "Store Rosters", Users],
            ["review", "Identity review", ShieldCheck],
            ["exports", "Exports & sync", Download],
            ["schedule", "Schedule preview", ClipboardList],
            ["history", "Activity", ClipboardList],
            ...(account.role === "admin"
              ? [
                  ["all", "All Employees", Users],
                  ["admin", "IDAD Admin Profile", Settings2],
                ]
              : []),
          ].map(([key, title, Icon]) => {
            const I = Icon as typeof Users;
            return (
              <button
                key={key as string}
                className={view === key ? "selected" : ""}
                onClick={() => {
                  setView(key as string);
                  setEditor(null);
                  setError("");
                }}
              >
                <I size={19} />
                {title as string}
                {key === "review" && (
                  <span className="nav-count">
                    {rows.filter((e) => e.verification === "review").length +
                      candidates.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="account-avatar">AD</div>
          <div>
            <strong>{account.id}</strong>
            <small>IDAD Administrator</small>
          </div>
          <button
            className="icon-button"
            title="Sign out"
            aria-label="Sign out"
            onClick={signOut}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            People <ChevronRight size={14} /> Employee directory
          </span>
          <span className="workspace-state">
            <i />
            {demo
              ? "Local demo"
              : production
                ? "Production"
                : "Isolated test environment"}
          </span>
        </header>
        <main className="content">
          {error && (
            <div role="alert" className="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notice && (
            <div role="status" className="success">
              <Check size={16} />
              {notice}
              <button onClick={() => setNotice("")}>Dismiss</button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {view === "all" && !editor
                  ? "ALL STORES / EMPLOYEE DIRECTORY"
                  : view === "review" && !editor
                    ? "ALL STORES / IDENTITY REVIEW"
                    : `${store?.state.toUpperCase()} / ${store?.brand}`}
              </span>
              <h1>
                {editor
                  ? "Employee details"
                  : view === "all"
                    ? "All Employees"
                    : view === "review"
                      ? "Identity review"
                      : view === "exports"
                        ? "Exports & sync"
                        : view === "history"
                          ? "Activity"
                          : view === "schedule"
                            ? "Schedule preview"
                            : view === "admin"
                              ? "IDAD Admin Profile"
                              : "Your team"}
              </h1>
              <p className="muted">
                {view === "review"
                  ? "Review POS details and confirm employee identities."
                  : view === "exports"
                    ? "Use stable employee IDs in your schedule."
                    : view === "history"
                      ? "Changes recorded by store and administrator accounts."
                      : view === "admin"
                        ? "Manage the portal's only active access profile."
                        : "Keep employee details current, from first shift onward."}
              </p>
            </div>
            {((view !== "all" && view !== "review") || editor) && (
              <label className="store-picker">
                <span>
                  <Building2 size={16} /> Store
                </span>
                <select
                  aria-label="Current store"
                  value={storeId}
                  onChange={(e) => {
                    setStoreId(e.target.value);
                    setRows([]);
                    setEditor(null);
                  }}
                >
                  {allStores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id} · {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {editor ? (
            <EmployeeEditor
              employee={editor === "new" ? undefined : editor}
              candidate={editor === "new" ? selectedCandidate : undefined}
              store={store!}
              admin={account.role === "admin"}
              onClose={() => {
                setEditor(null);
                setSelectedCandidate(undefined);
              }}
              onSaved={async () => {
                setEditor(null);
                setSelectedCandidate(undefined);
                setNotice(
                  "Employee record saved. Draft dropdowns update on the next sync.",
                );
                await load();
              }}
            />
          ) : (
            <>
              {view === "all" && account.role === "admin" && (
                <AllEmployees
                  onChanged={load}
                  stores={allStores}
                  initialCandidate={selectedCandidate}
                  onReviewNew={(c) => {
                    setSelectedCandidate(c);
                    setStoreId(c.storeId);
                    setEditor("new");
                  }}
                />
              )}
              {(view === "employees" || view === "review") && (
                <>
                  {candidates.length > 0 && (
                    <section className="panel card">
                      <h2>New employees to review ({candidates.length})</h2>
                      <p>
                        Found in the POS roster. Confirm each name before adding
                        them to the active directory.
                      </p>
                      {candidates.map((c) => (
                        <div key={c.id} className="panel-title">
                          <div>
                            <strong>{c.posName}</strong>
                            <p className="muted">
                              {c.storeId} ·{" "}
                              {allStores.find((s) => s.id === c.storeId)
                                ?.name || "Store"}
                              {" · "}
                              {c.inCurrentRoster
                                ? "Present in the latest roster"
                                : "Seen previously; absent from the latest roster"}
                            </p>
                          </div>
                          <div className="candidate-actions">
                            <button
                              className="secondary"
                              disabled={busyCandidate === c.id}
                              onClick={() => {
                                setSelectedCandidate(c);
                                setView("all");
                              }}
                            >
                              Link existing employee
                            </button>
                            <button
                              className="secondary"
                              disabled={busyCandidate === c.id}
                              onClick={() => {
                                setSelectedCandidate(c);
                                setStoreId(c.storeId);
                                setEditor("new");
                              }}
                            >
                              Review as new employee
                            </button>
                            <button
                              className="text-link"
                              disabled={busyCandidate === c.id}
                              onClick={() => void archiveReview(c)}
                            >
                              <Archive size={16} />
                              {busyCandidate === c.id
                                ? "Archiving…"
                                : "Archive review"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </section>
                  )}
                  {view === "review" && archivedCandidates.length > 0 && (
                    <section className="panel card archived-reviews">
                      <details>
                        <summary>
                          Archived reviews ({archivedCandidates.length})
                        </summary>
                        <p>
                          These POS identities were reviewed without creating or
                          linking an employee record.
                        </p>
                        {archivedCandidates.map((candidate) => (
                          <div key={candidate.id} className="panel-title">
                            <div>
                              <strong>{candidate.posName}</strong>
                              <p className="muted">
                                {candidate.storeId} ·{" "}
                                {allStores.find(
                                  (store) => store.id === candidate.storeId,
                                )?.name || "Store"}
                                {" · Archived "}
                                {candidate.archivedAt
                                  ? new Date(
                                      candidate.archivedAt,
                                    ).toLocaleString()
                                  : "previously"}
                                {candidate.archivedBy
                                  ? ` by ${candidate.archivedBy}`
                                  : ""}
                              </p>
                            </div>
                            <button
                              className="secondary"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void restoreReview(candidate)}
                            >
                              <RotateCcw size={16} />
                              {busyCandidate === candidate.id
                                ? "Restoring…"
                                : "Return to review"}
                            </button>
                          </div>
                        ))}
                      </details>
                    </section>
                  )}
                  <div className="stats">
                    <div>
                      <span>Active employees</span>
                      <strong>
                        {active.length.toString().padStart(2, "0")}
                      </strong>
                      <small>Ready for your schedule</small>
                    </div>
                    <div>
                      <span>
                        <ShieldCheck size={16} /> POS confirmed
                      </span>
                      <strong>
                        {active
                          .filter((e) =>
                            ["confirmed", "manual"].includes(e.verification),
                          )
                          .length.toString()
                          .padStart(2, "0")}
                      </strong>
                      <small>Identity verified</small>
                    </div>
                    <div>
                      <span>
                        <Clock3 size={16} /> Awaiting confirmation
                      </span>
                      <strong>
                        {active
                          .filter((e) => e.verification === "awaiting")
                          .length.toString()
                          .padStart(2, "0")}
                      </strong>
                      <small>Can still be scheduled</small>
                    </div>
                    <div>
                      <span>
                        <TriangleAlert size={16} /> Needs review
                      </span>
                      <strong>
                        {active
                          .filter((e) => e.verification === "review")
                          .length.toString()
                          .padStart(2, "0")}
                      </strong>
                      <small>Check POS details</small>
                    </div>
                  </div>
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>
                          {view === "review"
                            ? "Employees to review"
                            : "Employee directory"}
                        </h2>
                        <span>
                          {view === "review" ? "All stores" : store?.id}{" "}
                          <span className="dot">·</span> {rows.length} total
                          records
                        </span>
                      </div>
                      <button
                        className="primary"
                        onClick={() => {
                          setSelectedCandidate(undefined);
                          setEditor("new");
                        }}
                      >
                        <Plus size={17} />
                        Add employee
                      </button>
                    </div>
                    <div className="table-tools">
                      <label className="search">
                        <Search size={18} />
                        <input
                          aria-label="Search employees"
                          placeholder="Search name, alias or employee ID"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      <div className="segments">
                        {["active", "inactive", "all"].map((x) => (
                          <button
                            key={x}
                            className={status === x ? "active" : ""}
                            onClick={() => setStatus(x)}
                          >
                            {x === "all"
                              ? "All employees"
                              : x[0].toUpperCase() + x.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Employee</th>
                            <th>POS employee ID</th>
                            <th>Verification</th>
                            <th>Status</th>
                            <th>
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((e) => (
                            <tr key={e.id}>
                              <td>
                                <button
                                  className="employee-cell"
                                  onClick={() => {
                                    setStoreId(e.storeId);
                                    setEditor(e);
                                  }}
                                >
                                  <span className="avatar">
                                    {e.firstName[0]}
                                    {e.lastName[0]}
                                  </span>
                                  <span>
                                    <strong>{e.displayName}</strong>
                                    <small>{e.posName}</small>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <span className="mono">
                                  {e.posIdentityPending
                                    ? "Pending"
                                    : e.posEmployeeId}
                                </span>
                                <small>{e.posSource}</small>
                              </td>
                              <td>
                                <Badge value={e.verification} />
                              </td>
                              <td>
                                <span className={`status ${e.status}`}>
                                  {e.status === "active"
                                    ? "Active"
                                    : "Inactive"}
                                </span>
                              </td>
                              <td>
                                <button
                                  aria-label={`Edit ${e.displayName}`}
                                  className="icon-button"
                                  onClick={() => {
                                    setStoreId(e.storeId);
                                    setEditor(e);
                                  }}
                                >
                                  <ChevronRight size={18} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!visible.length && (
                        <div className="empty">
                          <Users size={28} />
                          <h3>
                            {loaded
                              ? "No employees found"
                              : "Loading employees…"}
                          </h3>
                          {loaded && (
                            <p>
                              {view === "review"
                                ? "No employee identities currently need review."
                                : "Adjust your search or add an employee to this store."}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                    <footer className="table-footer">
                      <span>{visible.length} employees shown</span>
                      <span>Names for people. IDs for accurate matching.</span>
                    </footer>
                  </section>
                  <div className="info-strip">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>New hires don’t have to wait.</strong>
                      <p>
                        Employees awaiting POS confirmation can be scheduled. A
                        roster refresh checks their identity when clock activity
                        becomes available.
                      </p>
                    </div>
                  </div>
                </>
              )}
              {view === "exports" && (
                <div className="cards">
                  <section className="panel card">
                    <Download size={24} />
                    <h2>Schedule roster</h2>
                    <p>
                      Active employees with stable IDs and schedule display
                      names. Identical display names include the POS ID in the
                      extended roster.
                    </p>
                    <a
                      className="primary"
                      href={
                        "/api/v1/roster.csv?storeId=" +
                        encodeURIComponent(storeId)
                      }
                    >
                      <Download size={16} />
                      Download CSV
                    </a>
                    <a
                      className="text-link"
                      href={
                        "/api/v1/roster?storeId=" + encodeURIComponent(storeId)
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      View extended JSON <ArrowUpRight size={16} />
                    </a>
                    <p className="muted">
                      The CSV preserves Store ID, Employee name, and Employee ID
                      columns.
                    </p>
                  </section>
                  <section className="panel card">
                    <RefreshCw size={24} />
                    <h2>POS roster refresh</h2>
                    <dl>
                      <dt>Last successful refresh</dt>
                      <dd>
                        {sync.lastSuccess
                          ? new Date(sync.lastSuccess).toLocaleString()
                          : "Not refreshed yet"}
                      </dd>
                      <dt>Source observed</dt>
                      <dd>
                        {sync.observedAt
                          ? new Date(sync.observedAt).toLocaleString()
                          : "No accepted snapshot"}
                      </dd>
                    </dl>
                    {sync.error && (
                      <p role="alert" className="alert">
                        {sync.error}
                      </p>
                    )}
                    <p>
                      Clock activity in the upstream roster confirms identities.
                      Missing activity never removes an employee.
                    </p>
                    {account.role === "admin" ? (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={refresh}
                      >
                        <RefreshCw size={16} />
                        {busy
                          ? "Checking…"
                          : demo
                            ? "Check fictional roster"
                            : "Refresh roster"}
                      </button>
                    ) : (
                      <p className="muted">
                        An administrator can refresh the POS roster.
                      </p>
                    )}
                  </section>
                </div>
              )}
              {view === "schedule" && (
                <DraftSchedule
                  key={storeId}
                  storeId={storeId}
                  admin={account.role === "admin"}
                />
              )}
              {view === "schedule" && demo && (
                <SchedulePreview
                  key={storeId}
                  employees={rows}
                  storeId={storeId}
                />
              )}
              {view === "history" && (
                <section className="panel card">
                  <h2>Recent changes</h2>
                  {audit.filter((a) => !a.storeId || a.storeId === storeId)
                    .length ? (
                    audit
                      .filter((a) => !a.storeId || a.storeId === storeId)
                      .map((a) => (
                        <div className="activity" key={a.id}>
                          <ClipboardList size={18} />
                          <div>
                            <strong>
                              {a.action
                                .replaceAll(".", " / ")
                                .replaceAll("-", " ")}
                            </strong>
                            <p>
                              {a.after
                                ? `${a.after.firstName} ${a.after.lastName} · `
                                : ""}
                              {a.actor}
                              {a.reason ? ` · ${a.reason}` : ""}
                            </p>
                          </div>
                          <time>{new Date(a.at).toLocaleString()}</time>
                        </div>
                      ))
                  ) : (
                    <p className="muted">Employee changes will appear here.</p>
                  )}
                </section>
              )}
              {view === "admin" && account.role === "admin" && (
                <AccessEditor
                  onSaved={() =>
                    setNotice(
                      "IDAD Admin access code updated. Existing sessions were revoked.",
                    )
                  }
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>IDAD Employee Report Directory</span>
            <span>
              {demo
                ? "Fictional data · existing schedules untouched"
                : production
                  ? "Production employee directory"
                  : "Test environment · no production cutover"}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function EmployeeEditor({
  employee,
  candidate,
  store,
  admin,
  onClose,
  onSaved,
}: {
  employee?: Row;
  candidate?: RosterCandidate;
  store: Store;
  admin: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const candidateName = candidate?.posName.trim().split(/\s+/) || [];
  const [first, setFirst] = useState(
      employee?.firstName || candidateName[0] || "",
    ),
    [last, setLast] = useState(
      employee?.lastName || candidateName.slice(1).join(" "),
    ),
    [preferred, setPreferred] = useState(employee?.preferredName || "");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      await api(
        employee
          ? "employees/" + employee.id
          : candidate
            ? "candidates/" + candidate.id + "/accept"
            : "employees",
        employee ? "PATCH" : "POST",
        {
          storeId: employee?.storeId || store.id,
          posSource: store.posSource,
          posEmployeeId: data.get("posEmployeeId"),
          posName: data.get("posName"),
          firstName: first,
          lastName: last,
          preferredName: preferred,
          aliases: String(data.get("aliases") || "")
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          status: data.get("status"),
          ...(employee ? { revision: employee.revision } : {}),
          reason: data.get("reason") || undefined,
        },
      );
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    try {
      await api("admin/employees/" + employee!.id + "/verify", "POST", {
        revision: employee!.revision,
        reason: data.get("reason"),
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <button className="text-link back" onClick={onClose}>
        <ArrowLeft size={16} />
        Back to employees
      </button>
      <div className="editor-grid">
        <form className="panel card" onSubmit={submit}>
          <h2>{employee ? "Edit employee" : "Add an employee"}</h2>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
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
            <label className="full">
              Preferred schedule name <span className="optional">Optional</span>
              <input
                maxLength={100}
                value={preferred}
                onChange={(e) => setPreferred(e.target.value)}
                placeholder={
                  first && last
                    ? `${first} ${Array.from(last)[0]}.`
                    : "First name + last initial"
                }
              />
              <small>Leave blank to use the default name.</small>
            </label>
            <label>
              POS employee ID
              <input
                name="posEmployeeId"
                required={!employee?.posIdentityPending}
                maxLength={80}
                defaultValue={
                  employee?.posEmployeeId || candidate?.posEmployeeId
                }
                readOnly={!!candidate || (!!employee && !admin)}
              />
              <small>Keep leading zeros exactly as entered.</small>
            </label>
            <label>
              Full POS name
              <input
                name="posName"
                required
                maxLength={160}
                defaultValue={employee?.posName || candidate?.posName}
                readOnly={!!candidate || (!!employee && !admin)}
              />
            </label>
            <label className="full">
              Known aliases <span className="optional">Optional</span>
              <textarea
                name="aliases"
                rows={3}
                defaultValue={employee?.aliases.join("\n")}
              />
              <small>
                One name per line. Aliases help search; they never determine
                identity.
              </small>
            </label>
            <label>
              Status
              <select name="status" defaultValue={employee?.status || "active"}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            {employee && admin && (
              <label className="full">
                Reason for POS identity correction
                <input name="reason" maxLength={500} />
                <small>Required if you change the POS ID or POS name.</small>
              </label>
            )}
          </div>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving}>
              {saving ? "Saving…" : "Save employee"}
            </button>
          </div>
        </form>
        <aside>
          <section className="panel card">
            <span className="eyebrow">SCHEDULE DISPLAY</span>
            <h2 className="display-preview">
              {preferred.trim() ||
                (first && last
                  ? `${first} ${Array.from(last)[0]}.`
                  : "Your employee")}
            </h2>
            <p>
              {store.id} · {store.posSource}
            </p>
            {employee ? (
              <Badge value={employee.verification} />
            ) : (
              <Badge value="awaiting" />
            )}
            <hr />
            <p>Scheduling is available before POS confirmation.</p>
            {employee?.observedPosName && (
              <>
                <small>Latest observed POS name</small>
                <p>{employee.observedPosName}</p>
              </>
            )}
            {employee?.manualReason && (
              <p>Verification note: {employee.manualReason}</p>
            )}
            {employee && !admin && (
              <p className="muted">
                Ask an administrator to correct an existing POS identity.
              </p>
            )}
          </section>
          {employee && admin && (
            <form className="panel card verification-form" onSubmit={verify}>
              <h3>Confirm identity manually</h3>
              <label>
                Verification reason
                <textarea
                  name="reason"
                  required
                  minLength={3}
                  maxLength={500}
                />
              </label>
              <button className="secondary" disabled={saving}>
                Confirm identity
              </button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
function AccessEditor({ onSaved }: { onSaved: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      await api("admin/access/reset", "POST", Object.fromEntries(data));
      form.reset();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel card access-form" onSubmit={submit}>
      <h2>Update IDAD Admin access</h2>
      <p>
        This is the only active portal profile. Updating its code signs out all
        existing IDAD Admin sessions.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <input name="accountId" type="hidden" value={ADMIN_ACCOUNT_ID} />
      <label>
        New access code
        <input
          name="code"
          type="password"
          autoComplete="new-password"
          required
          minLength={1}
          maxLength={200}
        />
      </label>
      <label>
        Reason
        <input name="reason" required minLength={3} maxLength={500} />
      </label>
      <button className="primary" disabled={busy}>
        {busy ? "Resetting…" : "Reset code & revoke sessions"}
      </button>
    </form>
  );
}
