"use client";
import { useEffect, useState } from "react";
import type { State } from "@/lib/model";
import type { DraftExport } from "@/lib/draft-schedule";
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
    setResult(undefined);
    setExclusions("");
    setOvernight("");
  }, [storeId]);
  async function run(sync = false) {
    setBusy(true);
    setError("");
    try {
      if (sync) {
        await request("draft/sync", {});
        setStatus(await request("draft/status"));
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
  return (
    <section className="panel card">
      <h2>{california ? "California Jamba" : "Texas"} Schedule connection</h2>
      <p>
        Managers continue scheduling in column {california ? "R" : "N"} and the
        existing daily time cells.
      </p>
      <a
        className="text-link"
        href={
          california
            ? "https://docs.google.com/spreadsheets/d/1hJRgrxJ5k6EQ8SpYH3QpMQbR5egWJyLiUHLfPGkCS4I/edit#gid=1883086419"
            : "https://docs.google.com/spreadsheets/d/1ugYhBd-Bw5kOTyGMWgi6vJsvK-KXMqeZ032lOZo6xZc/edit#gid=1883086419"
        }
        target="_blank"
        rel="noreferrer"
      >
        Open private schedule draft
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
      {admin && (
        <button className="secondary" disabled={busy} onClick={() => run(true)}>
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
            The date comes from Texas Schedule P1. Every populated mapped shift
            is validated. Errors leave the previous accepted export intact.
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
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
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
                {result.snapshot.shifts.reduce((n, s) => n + s.minutes, 0) / 60}{" "}
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
                {result.snapshot.ready ? "validated export" : "review results"}
              </button>
              <p className="muted">
                Private schedule draft export. Live schedules and labor reports
                have not been updated.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
