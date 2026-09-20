"use client";
import { useEffect, useState } from "react";
import type { State } from "@/lib/model";
import type { DraftExport } from "@/lib/draft-schedule";
import type { ScheduleTarget, ScheduleTargetState } from "@/lib/model";
import {
  scheduleSyncNotice,
  type ScheduleSyncResponse,
} from "@/lib/schedule-sync-result";
type TargetOption = Pick<
  ScheduleTarget,
  | "state"
  | "targetKey"
  | "kind"
  | "scheduleId"
  | "spreadsheetId"
  | "sheetName"
  | "sheetUrl"
  | "weekStart"
  | "weekEnd"
>;
type TargetOverview = {
  configured: boolean;
  states: Record<
    ScheduleTargetState,
    { active: ScheduleTarget; options: TargetOption[] }
  >;
};
const californiaStores = new Set([
  "JJ-025",
  "JJ-125",
  "JJ-171",
  "JJ-548",
  "JJ-552",
  "JJ-104833",
]);
export default function DraftSchedule({
  storeId,
  admin,
}: {
  storeId: string;
  admin: boolean;
}) {
  const [status, setStatus] = useState<{
      configured?: boolean;
      workerFresh?: boolean;
      automation?: State["sync"]["automation"];
    }>({}),
    [result, setResult] = useState<DraftExport>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [targetBusy, setTargetBusy] = useState<ScheduleTargetState>(),
    [targets, setTargets] = useState<TargetOverview>(),
    [targetSelection, setTargetSelection] = useState<
      Partial<Record<ScheduleTargetState, string>>
    >({}),
    [targetNotice, setTargetNotice] = useState(""),
    [targetErrors, setTargetErrors] = useState<
      Partial<Record<ScheduleTargetState, string>>
    >({}),
    [exclusions, setExclusions] = useState(""),
    [overnight, setOvernight] = useState("");
  const california = californiaStores.has(storeId);
  async function request(path: string, body?: unknown) {
    const r = await fetch("/api/v1/" + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed");
    return d;
  }
  useEffect(() => {
    let alive = true;
    const load = () =>
      request("draft/status")
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!admin) return;
    let alive = true;
    request("draft/targets")
      .then((value: TargetOverview) => {
        if (!alive) return;
        setTargets(value);
        setTargetSelection({
          texas: value.states.texas.active.targetKey,
          california: value.states.california.active.targetKey,
        });
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [admin]);
  useEffect(() => {
    setResult(undefined);
    setExclusions("");
    setOvernight("");
  }, [storeId]);
  async function run(sync = false) {
    setBusy(true);
    setError("");
    try {
      if (sync) {
        const response = (await request("draft/sync", {
          state: california ? "california" : "texas",
        })) as ScheduleSyncResponse;
        setStatus(await request("draft/status"));
        setTargetNotice(scheduleSyncNotice(response));
      } else {
        const excluded = exclusions
          .split("\n")
          .filter((s) => s.trim())
          .map((s) => {
            const [row, ...reason] = s.split(":");
            return { row: Number(row), reason: reason.join(":").trim() };
          });
        const nights = overnight
          .split("\n")
          .filter((s) => s.trim())
          .map((s) => {
            const [row, day] = s.split(":");
            return { row: Number(row), day: Number(day) };
          });
        setResult(
          await request("draft/export", {
            storeId,
            exclusions: excluded,
            overnight: nights,
          }),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reloadTargets() {
    const value = (await request("draft/targets")) as TargetOverview;
    setTargets(value);
    setTargetSelection({
      texas: value.states.texas.active.targetKey,
      california: value.states.california.active.targetKey,
    });
    return value;
  }
  async function saveTarget(state: ScheduleTargetState) {
    const targetKey = targetSelection[state];
    if (!targetKey) return;
    setTargetBusy(state);
    setError("");
    setTargetNotice("");
    setTargetErrors((current) => ({ ...current, [state]: undefined }));
    try {
      await request("draft/targets", { state, targetKey });
      await reloadTargets();
      setTargetNotice(
        `${state === "texas" ? "Texas" : "California"} target saved. No schedule update was run.`,
      );
    } catch (e) {
      setTargetErrors((current) => ({
        ...current,
        [state]: (e as Error).message,
      }));
    } finally {
      setTargetBusy(undefined);
    }
  }
  async function syncTarget(state: ScheduleTargetState) {
    setTargetBusy(state);
    setError("");
    setTargetNotice("");
    setTargetErrors((current) => ({ ...current, [state]: undefined }));
    try {
      const response = (await request("draft/sync", {
        state,
      })) as ScheduleSyncResponse;
      await Promise.all([
        reloadTargets(),
        request("draft/status").then(setStatus),
      ]);
      setTargetNotice(scheduleSyncNotice(response));
    } catch (e) {
      setTargetErrors((current) => ({
        ...current,
        [state]: (e as Error).message,
      }));
      await reloadTargets().catch(() => undefined);
    } finally {
      setTargetBusy(undefined);
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${storeId}-${result.snapshot.weekStart}-draft-shifts.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!california && !storeId.startsWith("TX-"))
    return (
      <section className="panel card">
        <h2>Schedule connection</h2>
        <p>
          Directory-controlled schedule dropdowns are not configured for{" "}
          {storeId}.
        </p>
      </section>
    );
  const currentState: ScheduleTargetState = california ? "california" : "texas",
    currentTarget = targets?.states[currentState].active;
  return (
    <>
      {admin && targets && (
        <section className="panel card schedule-targets">
          <div>
            <h2>Schedule update targets</h2>
            <p className="muted">
              Saving changes future syncs only. It does not update a workbook.
            </p>
          </div>
          {targetNotice && (
            <p role="status" className="success">
              {targetNotice}
            </p>
          )}
          <div className="schedule-target-grid">
            {(["texas", "california"] as const).map((state) => {
              const details = targets.states[state],
                active = details.active,
                selected = targetSelection[state] || active.targetKey,
                changed = selected !== active.targetKey,
                targetError = targetErrors[state];
              return (
                <article className="schedule-target-card" key={state}>
                  <div>
                    <span className="eyebrow">
                      {state === "texas" ? "TEXAS" : "CALIFORNIA"}
                    </span>
                    <h3>{active.sheetName}</h3>
                    <p className="muted">
                      {targetError?.includes("as Editor")
                        ? "Needs access"
                        : targetError
                          ? "Needs preparation"
                          : active.readiness === "test-draft"
                            ? "Test draft"
                            : active.readiness === "needs-preparation"
                              ? "Needs preparation"
                              : active.readiness === "sync-failed"
                                ? "Sync failed"
                                : "Ready"}
                      {active.weekStart && active.weekEnd
                        ? ` · ${active.weekStart}–${active.weekEnd}`
                        : ""}
                    </p>
                  </div>
                  <label>
                    Schedule destination
                    <select
                      value={selected}
                      disabled={targetBusy === state}
                      onChange={(event) =>
                        setTargetSelection((current) => ({
                          ...current,
                          [state]: event.target.value,
                        }))
                      }
                    >
                      {details.options.map((option) => (
                        <option key={option.targetKey} value={option.targetKey}>
                          {option.sheetName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="schedule-target-actions">
                    <button
                      className="primary"
                      disabled={!changed || targetBusy === state}
                      onClick={() => saveTarget(state)}
                    >
                      {targetBusy === state ? "Checking…" : "Save target"}
                    </button>
                    <button
                      className="secondary"
                      disabled={changed || targetBusy === state}
                      onClick={() => syncTarget(state)}
                    >
                      {targetBusy === state ? "Syncing…" : "Sync now"}
                    </button>
                    <a
                      className="text-link"
                      href={active.sheetUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open schedule
                    </a>
                  </div>
                  <p className="muted">
                    Last synced:{" "}
                    {active.lastSync?.at
                      ? new Date(active.lastSync.at).toLocaleString()
                      : "Not yet synced for this target"}
                  </p>
                  {active.lastSync?.status === "failed" &&
                    active.lastSync.message && (
                      <p role="alert" className="alert">
                        {active.lastSync.message}
                      </p>
                    )}
                  {targetError && (
                    <p role="alert" className="alert">
                      {targetError}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          {!targets.configured && (
            <p className="muted">
              ScheduleDB is not configured in this environment; only current
              directory drafts are available.
            </p>
          )}
        </section>
      )}
      <section className="panel card">
        <h2>{california ? "California Jamba" : "Texas"} Schedule connection</h2>
        <p>
          Managers continue scheduling in column {california ? "R" : "N"} and
          the existing daily time cells.
        </p>
        <a
          className="text-link"
          href={
            currentTarget?.sheetUrl ||
            (california
              ? "https://docs.google.com/spreadsheets/d/1hJRgrxJ5k6EQ8SpYH3QpMQbR5egWJyLiUHLfPGkCS4I/edit#gid=1883086419"
              : "https://docs.google.com/spreadsheets/d/1ugYhBd-Bw5kOTyGMWgi6vJsvK-KXMqeZ032lOZo6xZc/edit#gid=1883086419")
          }
          target="_blank"
          rel="noreferrer"
        >
          Open active schedule target
        </a>
        <p>
          {!status.configured
            ? "Schedule connection is not enabled for this environment."
            : status.workerFresh
              ? status.automation?.cadence === "daily"
                ? "Daily automatic sync is up to date."
                : "Local sync worker is running."
              : "Automatic sync is not reporting; updates may be paused."}
        </p>
        <p className="muted">
          Last draft sync:{" "}
          {status.automation?.lastDraft
            ? new Date(status.automation.lastDraft).toLocaleString()
            : "Not yet synced"}
          .{" "}
          {status.automation?.cadence === "daily"
            ? "Automatic updates run daily. Administrators can also refresh the roster and sync dropdowns manually."
            : "The local worker updates dropdowns about once per minute and checks the POS source every 15 minutes while running."}
        </p>
        {status.automation?.error && (
          <p role="alert" className="alert">
            {status.automation.error}
          </p>
        )}
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        {admin && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => run(true)}
          >
            Sync dropdowns now
          </button>
        )}
        {california ? (
          <p className="muted">
            Employee Names Master and all 105 California column-R dropdowns are
            controlled by the directory. California shift export is not enabled.
          </p>
        ) : (
          <>
            <h3>Validate and export {storeId} shifts</h3>
            <p>
              The date comes from Texas Schedule P1. Every populated mapped
              shift is validated. Errors leave the previous accepted export
              intact.
            </p>
            <label>
              Explicit exclusions (optional)
              <textarea
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                placeholder="38: New hire not entered yet"
              />
              <small>
                One schedule row and reason per line. Excluded shifts remain
                listed in the export; they are not a complete store snapshot.
              </small>
            </label>
            <label>
              Overnight shifts (optional)
              <textarea
                value={overnight}
                onChange={(e) => setOvernight(e.target.value)}
                placeholder="22:0"
              />
              <small>
                One row:day per line, with Sunday = 0 through Saturday = 6. Use
                only when the shift ends the next day.
              </small>
            </label>
            <button
              className="primary"
              disabled={busy || !status.configured}
              onClick={() => run()}
            >
              {busy ? "Checking…" : "Validate and export shifts"}
            </button>
            {result && (
              <div>
                <h3>
                  {result.snapshot.ready
                    ? result.omitted.length
                      ? "Validated with exclusions"
                      : "Validated"
                    : "Needs review"}{" "}
                  • {result.snapshot.weekStart}
                </h3>
                <p>
                  {result.snapshot.valid} valid shifts ·{" "}
                  {result.snapshot.shifts.reduce((n, s) => n + s.minutes, 0) /
                    60}{" "}
                  hours · {result.snapshot.exceptionCount} issues ·{" "}
                  {result.omitted.length} explicitly excluded shifts
                </p>
                {result.snapshot.shifts.some((s) => s.posIdentityPending) && (
                  <p role="status" className="alert">
                    Schedule export only:{" "}
                    {
                      result.snapshot.shifts.filter((s) => s.posIdentityPending)
                        .length
                    }{" "}
                    shifts have POS verification pending. Actual labor matching
                    remains unresolved.
                  </p>
                )}
                {result.snapshot.exceptions.map((e) => (
                  <p key={e.sourceIndex} className="alert">
                    Row {e.row}: {e.reason}
                  </p>
                ))}
                {result.omitted.map((e) => (
                  <p key={e.row + e.date}>
                    Excluded row {e.row}, {e.date}: {e.reason}
                  </p>
                ))}
                <button className="secondary" onClick={download}>
                  Download{" "}
                  {result.snapshot.ready
                    ? "validated export"
                    : "review results"}
                </button>
                <p className="muted">
                  Private schedule draft export. Live schedules and labor
                  reports have not been updated.
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
