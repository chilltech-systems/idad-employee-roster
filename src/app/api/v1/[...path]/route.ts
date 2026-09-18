import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertLocalDemo, mode, stores } from "@/lib/config";
import { repository } from "@/lib/repository";
import { canAccess, Problem, requireAdmin, requireStore } from "@/lib/model";
import {
  currentAccount,
  listCandidates,
  acceptCandidate,
  setCandidateArchived,
  listEmployees,
  login,
  logout,
  manualVerify,
  refresh,
  resetCode,
  rosterCsv,
  rosterRows,
  saveEmployee,
} from "@/lib/service";
import { exportShifts, laborPreview, shiftInputSchema } from "@/lib/shifts";
import { fetchRoster } from "@/lib/roster-source";
import { draftClient, DRAFT_ID } from "@/lib/google-draft";
import {
  draftExportKey,
  stableDraft,
  extractDraft,
  validateDraftExport,
  recordDraftExport,
} from "@/lib/draft-schedule";
import { syncDraftNow } from "@/lib/draft-operations";
import { retainPreviousRoster } from "@/lib/current-day-roster";
import { portalOrigin } from "@/lib/origin";
import { hasGoogleCredential } from "@/lib/google-credential";
import { CALIFORNIA_DRAFT_ID } from "@/lib/google-california-draft";
import {
  listPeople,
  savePerson,
  linkPeople,
  linkCandidate,
  migrationPreview,
} from "@/lib/people";
import {
  reportingDraftExportRequestSchema,
  requireReportingExportToken,
  validateReportingDraftExports,
} from "@/lib/reporting-draft-export";
import {
  activeScheduleTarget,
  resolveScheduleTarget,
  saveScheduleTarget,
  targetOverview,
} from "@/lib/schedule-targets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const cookieName = "idad_directory_session";
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    assertLocalDemo(req.nextUrl.hostname);
    const path = (await params).path.join("/");
    const method = req.method;
    const configuredOrigin = portalOrigin();
    const reportingExport =
      path === "reporting/draft-exports/validate" && method === "POST";
    if (
      !reportingExport &&
      !["GET", "HEAD"].includes(method) &&
      req.headers.get("origin") !== configuredOrigin
    )
      throw new Problem(403, "Request origin was rejected.");
    let body: unknown = {};
    if (!["GET", "HEAD"].includes(method)) {
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        throw new Problem(415, "JSON requests required.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = req.body?.getReader();
      if (!reader) throw new Problem(400, "JSON body required.");
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new Problem(413, "Request is too large.");
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        body = JSON.parse(text);
      } catch {
        throw new Problem(400, "Invalid JSON.");
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new Problem(400, "A JSON object is required.");
    const token = req.cookies.get(cookieName)?.value;
    const repo = repository();
    if (reportingExport) {
      requireReportingExportToken(req.headers.get("authorization"));
      const payload = reportingDraftExportRequestSchema.parse(body);
      const target = await repo.transact((state) =>
          structuredClone(activeScheduleTarget(state, "texas")),
        ),
        grid = await stableDraft(
          await draftClient(fetch, target.spreadsheetId),
          target.spreadsheetId,
        );
      const result = await repo.transact((state) =>
        validateReportingDraftExports(
          grid,
          state,
          payload,
          target.spreadsheetId,
        ),
      );
      return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "login" && method === "POST") {
      const result = await repo.transact((s) => login(s, body));
      if (result.error)
        return NextResponse.json(
          { error: result.error },
          { status: result.status },
        );
      const response = NextResponse.json({ account: result.account });
      response.cookies.set(cookieName, result.token!, {
        httpOnly: true,
        secure: configuredOrigin.startsWith("https:"),
        sameSite: "strict",
        path: "/",
        maxAge: 604800,
      });
      return response;
    }
    if (path === "login-options" && method === "GET")
      return NextResponse.json({
        stores: stores(),
        demo: mode() === "demo",
        production: mode() === "mongo-production",
      });
    if (path === "admin/refresh" && method === "POST") {
      const previous = await repo.transact((s) => {
        requireAdmin(currentAccount(s, token));
        return s.sync.snapshot ? structuredClone(s.sync.snapshot) : undefined;
      });
      let source;
      try {
        source = Object.keys(body as object).length
          ? body
          : retainPreviousRoster(
              await fetchRoster({ includeCurrentDay: true }),
              previous,
            );
      } catch (e) {
        await repo.transact((s) => {
          requireAdmin(currentAccount(s, token));
          s.sync.lastAttempt = new Date().toISOString();
          s.sync.error =
            "Roster source failed. Last successful snapshot retained.";
        });
        throw e;
      }
      const result = await repo.transact((s) =>
        refresh(s, currentAccount(s, token), source),
      );
      return NextResponse.json(result, { status: result.error ? 400 : 200 });
    }
    if (path === "draft/targets" && method === "GET") {
      const snapshot = await repo.transact((state) => {
        const account = currentAccount(state, token);
        requireAdmin(account);
        return { account, state: structuredClone(state) };
      });
      return NextResponse.json(
        await targetOverview(snapshot.state, snapshot.account),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path === "draft/targets" && method === "POST") {
      await repo.transact((state) =>
        requireAdmin(currentAccount(state, token)),
      );
      const resolved = await resolveScheduleTarget(body);
      const target = await repo.transact((state) =>
        saveScheduleTarget(state, currentAccount(state, token), resolved),
      );
      return NextResponse.json({ ok: true, target });
    }
    if (path === "draft/sync" && method === "POST") {
      await repo.transact((s) => requireAdmin(currentAccount(s, token)));
      const payload = z
        .object({ state: z.enum(["texas", "california"]).optional() })
        .strict()
        .parse(body);
      const result = await syncDraftNow(payload.state);
      return NextResponse.json(result);
    }
    if (path === "draft/export" && method === "POST") {
      const payload = z
        .object({
          storeId: z.string(),
          exclusions: z
            .array(
              z.object({
                row: z.number().int().positive(),
                reason: z.string().trim().min(5).max(300),
              }),
            )
            .max(174)
            .default([]),
          overnight: z
            .array(
              z.object({
                row: z.number().int().positive(),
                day: z.number().int().min(0).max(6),
              }),
            )
            .max(1197)
            .default([]),
        })
        .strict()
        .parse(body);
      await repo.transact((s) =>
        requireStore(currentAccount(s, token), payload.storeId),
      );
      const target = await repo.transact((state) =>
          structuredClone(activeScheduleTarget(state, "texas")),
        ),
        grid = await stableDraft(
          await draftClient(fetch, target.spreadsheetId),
          target.spreadsheetId,
        );
      const extracted = extractDraft(
        grid,
        payload.storeId,
        1,
        payload.exclusions,
        payload.overnight,
        target.spreadsheetId,
      );
      const key = draftExportKey(
        payload.storeId,
        extracted.input.weekStart,
        extracted.omitted.length > 0,
        target.spreadsheetId,
      );
      const result = await repo.transact((s) => {
        requireStore(currentAccount(s, token), payload.storeId);
        return recordDraftExport(
          s,
          validateDraftExport(
            grid,
            s.employees,
            payload.storeId,
            s.sync.draftExports?.[key],
            payload.exclusions,
            payload.overnight,
            target.spreadsheetId,
          ),
          currentAccount(s, token),
        );
      });
      return NextResponse.json(result);
    }
    let csv = false;
    const result = await repo.transact((s) => {
      const account = currentAccount(s, token);
      const storeId = req.nextUrl.searchParams.get("storeId") || undefined;
      if (path === "logout" && method === "POST") {
        logout(s, token!);
        return { ok: true };
      }
      if (path === "me" && method === "GET")
        return { account, demo: mode() === "demo" };
      if (path === "stores" && method === "GET")
        return stores().filter((x) => canAccess(account, x.id));
      if (path === "admin/people" && method === "GET")
        return listPeople(s, account);
      if (path === "admin/people/migration-preview" && method === "GET")
        return migrationPreview(s, account);
      const person = /^admin\/people\/([^/]+)(?:\/(link|candidate))?$/.exec(
        path,
      );
      if (person && method === "PATCH" && !person[2])
        return savePerson(s, account, person[1], body);
      if (person && method === "POST" && person[2] === "link")
        return linkPeople(s, account, person[1], body);
      if (person && method === "POST" && person[2] === "candidate")
        return linkCandidate(s, account, person[1], body);
      if (path === "employees" && method === "GET")
        return listEmployees(s, account, storeId);
      if (
        ["shifts/validate", "labor/preview"].includes(path) &&
        method === "POST"
      ) {
        const payload = z
          .object({
            storeId: z.string(),
            input: shiftInputSchema,
            punches: z.array(z.unknown()).optional(),
          })
          .strict()
          .parse(body);
        requireStore(account, payload.storeId);
        if (payload.input.cells.some((c) => c.storeId !== payload.storeId))
          throw new Problem(
            403,
            "Every shift must belong to the selected store.",
          );
        const employees = s.employees.filter(
          (e) => e.storeId === payload.storeId,
        );
        let snapshot;
        try {
          snapshot = exportShifts(payload.input, employees);
        } catch (e) {
          throw new Problem(400, (e as Error).message);
        }
        if (path === "shifts/validate") return snapshot;
        try {
          return laborPreview(snapshot, payload.punches);
        } catch (e) {
          throw new Problem(400, (e as Error).message);
        }
      }
      if (path === "candidates" && method === "GET")
        return (() => {
          const status = req.nextUrl.searchParams.get("status") || "pending";
          if (status !== "pending" && status !== "archived")
            throw new Problem(400, "Unknown candidate review status.");
          return listCandidates(s, account, storeId, status);
        })();
      const candidate = /^candidates\/([^/]+)\/accept$/.exec(path);
      if (candidate && method === "POST")
        return acceptCandidate(s, account, candidate[1], body);
      const candidateReview = /^candidates\/([^/]+)\/(archive|restore)$/.exec(
        path,
      );
      if (candidateReview && method === "POST") {
        z.object({}).strict().parse(body);
        return setCandidateArchived(
          s,
          account,
          candidateReview[1],
          candidateReview[2] === "archive",
        );
      }
      if (path === "draft/status" && method === "GET")
        return {
          configured:
            mode() !== "demo" &&
            process.env.PORTAL_DRAFT_ID === DRAFT_ID &&
            process.env.PORTAL_CALIFORNIA_DRAFT_ID === CALIFORNIA_DRAFT_ID &&
            hasGoogleCredential("draft"),
          targets: {
            texas: activeScheduleTarget(s, "texas"),
            california: activeScheduleTarget(s, "california"),
          },
          automation: s.sync.automation,
          workerFresh:
            !!s.sync.automation?.heartbeat &&
            Date.now() - Date.parse(s.sync.automation.heartbeat) <
              (s.sync.automation.cadence === "daily"
                ? 26 * 60 * 60_000
                : 180000),
        };
      if (path === "employees" && method === "POST")
        return saveEmployee(s, account, body);
      const edit = /^employees\/([^/]+)$/.exec(path);
      if (edit && method === "PATCH")
        return saveEmployee(s, account, body, edit[1]);
      const verify = /^admin\/employees\/([^/]+)\/verify$/.exec(path);
      if (verify && method === "POST")
        return manualVerify(s, account, verify[1], body);
      if (path === "admin/access/reset" && method === "POST")
        return resetCode(s, account, body);
      if (path === "audit" && method === "GET")
        return s.audit
          .filter(
            (x) => account.role === "admin" || x.storeId === account.storeId,
          )
          .slice(-200)
          .reverse();
      if (path === "sync" && method === "GET")
        return {
          lastSuccess: s.sync.lastSuccess,
          lastAttempt: s.sync.lastAttempt,
          error: s.sync.error,
          source: s.sync.snapshot?.source,
          observedAt: s.sync.snapshot?.observedAt,
        };
      if (["roster", "roster.csv"].includes(path) && method === "GET") {
        if (!storeId) throw new Problem(400, "A store is required.");
        if (!stores().some((x) => x.id === storeId))
          throw new Problem(404, "Store not found.");
        if (path.endsWith(".csv")) {
          csv = true;
          return rosterCsv(s, account, storeId);
        }
        return {
          version: 1,
          storeId,
          exportedAt: new Date().toISOString(),
          employees: rosterRows(s, account, storeId),
        };
      }
      throw new Problem(404, "Endpoint not found.");
    });
    const response = csv
      ? new NextResponse(result as string, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="employee-roster.csv"',
            "Cache-Control": "no-store",
          },
        })
      : NextResponse.json(result);
    if (path === "logout")
      response.cookies.set(cookieName, "", { maxAge: 0, path: "/" });
    return response;
  } catch (e) {
    if (e instanceof Problem)
      return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError)
      return NextResponse.json(
        {
          error: "Check the required fields.",
          fields: e.issues.map((x) => ({ path: x.path, message: x.message })),
        },
        { status: 400 },
      );
    const diagnostic =
      e instanceof Error
        ? e.message
            .replace(
              /mongodb(?:\+srv)?:\/\/[^@\s]+@/gi,
              "mongodb://[redacted]@",
            )
            .slice(0, 500)
        : "No error details were provided.";
    console.error(
      "Portal request failed:",
      e instanceof Error ? e.name : "Unknown error",
      diagnostic,
    );
    return NextResponse.json(
      {
        error:
          "The request could not be completed. Check local configuration or retry.",
      },
      { status: 500 },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH };
