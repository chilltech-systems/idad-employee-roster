"use client";
import { useState } from "react";
import { Plus, Trash2, Download, Check } from "lucide-react";
import type { Employee } from "@/lib/model";
import type { ShiftSnapshot } from "@/lib/shifts";
type Draft = {
  key: string;
  directoryId: string;
  businessDate: string;
  start: string;
  end: string;
  overnight: boolean;
};
export default function SchedulePreview({
  employees,
  storeId,
}: {
  employees: (Employee & { displayName: string })[];
  storeId: string;
}) {
  const [week, setWeek] = useState("2026-09-06"),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [result, setResult] = useState<ShiftSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(1);
  function change(key: string, patch: Partial<Draft>) {
    setDrafts((rows) =>
      rows.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    );
    setResult(null);
    setRevision((n) => n + 1);
  }
  async function validate() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/shifts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          input: {
            workbookId: "local-preview-" + storeId,
            weekStart: week,
            revision,
            cells: drafts.map((d, i) => ({
              sheet: "Local schedule preview",
              row: i + 1,
              slot: d.key,
              storeId,
              directoryId: d.directoryId,
              businessDate: d.businessDate,
              start: d.start,
              end: d.end,
              overnight: d.overnight,
            })),
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!result?.ready) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `employee-shifts-${storeId}-${week}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="panel card">
      <h2>Try a schedule export</h2>
      <p>
        Select employees from the directory and validate shifts before
        exporting. This local preview does not update a store schedule.
      </p>
      <label style={{ maxWidth: 260 }}>
        Week beginning Sunday
        <input
          type="date"
          value={week}
          onChange={(e) => {
            setWeek(e.target.value);
            setResult(null);
            setRevision((n) => n + 1);
          }}
        />
      </label>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="schedule-rows">
        {drafts.map((d) => (
          <div className="schedule-row" key={d.key}>
            <label>
              Employee
              <select
                value={d.directoryId}
                onChange={(e) => change(d.key, { directoryId: e.target.value })}
              >
                <option value="">Select employee</option>
                {employees
                  .filter((e) => e.status === "active")
                  .map((e) => (
                    <option value={e.id} key={e.id}>
                      {e.displayName} · {e.posEmployeeId}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                value={d.businessDate}
                onChange={(e) =>
                  change(d.key, { businessDate: e.target.value })
                }
              />
            </label>
            <label>
              Start
              <input
                type="time"
                value={d.start}
                onChange={(e) => change(d.key, { start: e.target.value })}
              />
            </label>
            <label>
              End
              <input
                type="time"
                value={d.end}
                onChange={(e) => change(d.key, { end: e.target.value })}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={d.overnight}
                onChange={(e) => change(d.key, { overnight: e.target.checked })}
              />
              Ends next day
            </label>
            <button
              className="icon-button"
              aria-label="Remove shift"
              onClick={() => {
                setDrafts((rows) => rows.filter((x) => x.key !== d.key));
                setResult(null);
                setRevision((n) => n + 1);
              }}
            >
              <Trash2 size={18} />
            </button>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button
          className="secondary"
          onClick={() => {
            setDrafts((rows) => [
              ...rows,
              {
                key: crypto.randomUUID(),
                directoryId: "",
                businessDate: week,
                start: "09:00",
                end: "15:00",
                overnight: false,
              },
            ]);
            setResult(null);
            setRevision((n) => n + 1);
          }}
        >
          <Plus size={16} />
          Add shift
        </button>
        <button className="primary" disabled={busy} onClick={validate}>
          {busy ? "Validating…" : "Validate shifts"}
        </button>
      </div>
      {result && (
        <div className="export-result">
          <h3>
            {result.valid} valid shifts · {result.exceptionCount} exceptions
          </h3>
          {result.ready ? (
            <>
              <p className="success">
                <Check size={16} />
                Every populated shift is accounted for.
              </p>
              <button className="secondary" onClick={download}>
                <Download size={16} />
                Download shift snapshot
              </button>
            </>
          ) : (
            <ul>
              {result.exceptions.map((e) => (
                <li key={e.sourceIndex}>
                  Shift {e.sourceIndex + 1}: {e.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
