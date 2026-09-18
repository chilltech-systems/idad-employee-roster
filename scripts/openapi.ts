import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { inputSchema, rosterSchema } from "../src/lib/model";
import { shiftInputSchema, punchSchema } from "../src/lib/shifts";
import {
  personUpdateSchema,
  personLinkSchema,
  candidateLinkSchema,
} from "../src/lib/people";
const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});
const object = { type: "object" };
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 500, 502, 503].map((code) => [
    code,
    {
      description: (
        {
          400: "Invalid input",
          401: "Sign-in required",
          403: "Forbidden",
          404: "Not found",
          409: "Duplicate identity or stale revision",
          413: "Payload too large",
          415: "JSON required",
          429: "Account temporarily rate-limited",
          500: "Configuration or storage error",
          502: "Roster source failed",
          503: "Roster adapter not configured",
        } as Record<number, string>
      )[code],
      content: json({
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      }),
    },
  ]),
);
const paths: Record<string, Record<string, unknown>> = {};
function endpoint(
  path: string,
  method: string,
  summary: string,
  schema?: Record<string, unknown>,
  options: {
    public?: boolean;
    reportingToken?: boolean;
    store?: boolean;
    csv?: boolean;
    id?: boolean;
    response?: Record<string, unknown>;
  } = {},
) {
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    operationId: method + "_" + path.replace(/[^a-zA-Z0-9]/g, "_"),
    security: options.public
      ? []
      : options.reportingToken
        ? [{ reportingToken: [] }]
        : [{ session: [] }],
    parameters: [
      ...(options.store
        ? [
            {
              in: "query",
              name: "storeId",
              required: !["/employees", "/candidates"].includes(path),
              schema: { type: "string" },
            },
          ]
        : []),
      ...(path === "/candidates" && method === "get"
        ? [
            {
              in: "query",
              name: "status",
              required: false,
              schema: {
                type: "string",
                enum: ["pending", "archived"],
                default: "pending",
              },
            },
          ]
        : []),
      ...(options.id
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ]
        : []),
      ...(method !== "get" && !options.reportingToken
        ? [
            {
              in: "header",
              name: "Origin",
              required: true,
              schema: { type: "string" },
              description:
                "Must equal PORTAL_ORIGIN exactly. JSON body required for every mutation.",
            },
          ]
        : []),
    ],
    ...(schema
      ? { requestBody: { required: true, content: json(schema) } }
      : {}),
    responses: {
      200: {
        description: "Success",
        content: options.csv
          ? { "text/csv": { schema: { type: "string" } } }
          : json(options.response ?? object),
      },
      ...errors,
    },
  };
}
endpoint(
  "/login-options",
  "get",
  "Configured stores and environment flags for the IDAD Admin login",
  undefined,
  { public: true },
);
endpoint(
  "/login",
  "post",
  "Sign in to the IDAD Admin Profile; retired single-store profiles are rejected",
  {
    type: "object",
    required: ["accountId", "code"],
    properties: {
      accountId: { type: "string" },
      code: { type: "string", writeOnly: true },
    },
    additionalProperties: false,
  },
  { public: true },
);
endpoint("/logout", "post", "Revoke current session", object);
endpoint("/me", "get", "Current account");
endpoint("/stores", "get", "Accessible states/brands/stores");
endpoint("/employees", "get", "List scoped employee records", undefined, {
  store: true,
});
endpoint(
  "/employees",
  "post",
  "Create permanent store/POS identity",
  z.toJSONSchema(inputSchema),
);
endpoint(
  "/employees/{id}",
  "patch",
  "Revision-checked edit; POS corrections require admin and reason",
  z.toJSONSchema(
    inputSchema.extend({
      posEmployeeId: z
        .string()
        .trim()
        .max(80)
        .describe(
          "Blank only when retaining an existing POS-pending assignment",
        ),
      revision: z.number().int().positive(),
      reason: z.string().optional(),
    }),
  ),
  { id: true },
);
endpoint(
  "/admin/employees/{id}/verify",
  "post",
  "Admin manually verifies identity with reason",
  {
    type: "object",
    required: ["revision", "reason"],
    properties: {
      revision: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 3, maxLength: 500 },
    },
  },
  { id: true },
);
endpoint(
  "/admin/access/reset",
  "post",
  "Update the IDAD Admin code and revoke all IDAD Admin sessions",
  {
    type: "object",
    required: ["accountId", "code", "reason"],
    properties: {
      accountId: { type: "string" },
      code: { type: "string", minLength: 1, maxLength: 200, writeOnly: true },
      reason: { type: "string", minLength: 3, maxLength: 500 },
    },
  },
);
endpoint(
  "/admin/refresh",
  "post",
  "Admin refresh: empty object fetches configured source; envelope performs reviewed import",
  {
    oneOf: [{ type: "object", maxProperties: 0 }, z.toJSONSchema(rosterSchema)],
  },
);
endpoint(
  "/sync",
  "get",
  "Last attempt, accepted snapshot time and refresh error",
);
endpoint("/audit", "get", "Latest 200 scoped audit records");
endpoint(
  "/roster",
  "get",
  "Active roster with permanent IDs and disambiguated labels",
  undefined,
  { store: true },
);
endpoint(
  "/roster.csv",
  "get",
  "Compatibility CSV: Store ID, Employee name, Employee ID",
  undefined,
  { store: true, csv: true },
);
endpoint(
  "/shifts/validate",
  "post",
  "Validate mapped shifts with full source reconciliation",
  {
    type: "object",
    required: ["storeId", "input"],
    properties: {
      storeId: { type: "string" },
      input: z.toJSONSchema(shiftInputSchema),
    },
  },
);
endpoint(
  "/labor/preview",
  "post",
  "Diagnostic local labor preview; not an approved PDF report",
  {
    type: "object",
    required: ["storeId", "input", "punches"],
    properties: {
      storeId: { type: "string" },
      input: z.toJSONSchema(shiftInputSchema),
      punches: { type: "array", items: z.toJSONSchema(punchSchema) },
    },
  },
);
endpoint(
  "/candidates",
  "get",
  "POS identities awaiting administrator review; optionally scoped by store",
  undefined,
  { store: true },
);
endpoint(
  "/candidates/{id}/accept",
  "post",
  "Confirm a discovered POS identity and create its directory record",
  z.toJSONSchema(inputSchema),
  { id: true },
);
endpoint(
  "/candidates/{id}/archive",
  "post",
  "Record an administrator-reviewed candidate without creating or linking an employee",
  object,
  { id: true },
);
endpoint(
  "/candidates/{id}/restore",
  "post",
  "Return an archived candidate to the active Identity Review queue",
  object,
  { id: true },
);
endpoint(
  "/draft/status",
  "get",
  "Private draft configuration, last sync and local worker heartbeat",
);
endpoint(
  "/draft/targets",
  "get",
  "Administrator lists active Texas and California targets, the pinned test drafts, and eight newest ScheduleDB schedules",
);
endpoint(
  "/draft/targets",
  "post",
  "Administrator verifies and saves a future schedule destination without writing to Google Sheets",
  {
    type: "object",
    required: ["state", "targetKey"],
    additionalProperties: false,
    properties: {
      state: { type: "string", enum: ["texas", "california"] },
      targetKey: { type: "string", minLength: 1, maxLength: 160 },
    },
  },
);
endpoint(
  "/draft/sync",
  "post",
  "Administrator syncs one selected state target or both selected targets",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      state: { type: "string", enum: ["texas", "california"] },
    },
  },
);
endpoint(
  "/draft/export",
  "post",
  "Validate live private draft shifts; accepted scoped tests are separate from full store snapshots",
  {
    type: "object",
    required: ["storeId"],
    additionalProperties: false,
    properties: {
      storeId: { type: "string" },
      exclusions: {
        type: "array",
        maxItems: 174,
        items: {
          type: "object",
          required: ["row", "reason"],
          additionalProperties: false,
          properties: {
            row: { type: "integer", minimum: 1 },
            reason: { type: "string", minLength: 5, maxLength: 300 },
          },
        },
      },
      overnight: {
        type: "array",
        maxItems: 1197,
        items: {
          type: "object",
          required: ["row", "day"],
          additionalProperties: false,
          properties: {
            row: { type: "integer", minimum: 1 },
            day: { type: "integer", minimum: 0, maximum: 6 },
          },
        },
      },
    },
  },
);
endpoint(
  "/reporting/draft-exports/validate",
  "post",
  "Machine-scoped validation and complete accepted shift exports for weekly labor reporting",
  {
    type: "object",
    required: ["weekStart", "storeIds"],
    additionalProperties: false,
    properties: {
      weekStart: { type: "string", format: "date" },
      storeIds: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 40 },
      },
    },
  },
  {
    reportingToken: true,
    response: {
      type: "object",
      required: [
        "version",
        "workbookId",
        "weekStart",
        "generatedAt",
        "results",
      ],
      properties: {
        version: { type: "integer", const: 1 },
        workbookId: { type: "string" },
        weekStart: { type: "string", format: "date" },
        generatedAt: { type: "string", format: "date-time" },
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["storeId", "status", "issues", "export"],
            properties: {
              storeId: { type: "string" },
              status: { type: "string", enum: ["ready", "blocked"] },
              issues: { type: "array", items: { type: "string" } },
              export: { anyOf: [{ type: "object" }, { type: "null" }] },
            },
          },
        },
      },
    },
  },
);
endpoint(
  "/admin/people",
  "get",
  "Admin: all shared employee profiles, sorted by first then last name",
);
endpoint(
  "/admin/people/migration-preview",
  "get",
  "Admin: read-only legacy profile migration preview; no automatic links",
);
endpoint(
  "/admin/people/{id}",
  "patch",
  "Admin: update profile and persistent assignments",
  z.toJSONSchema(personUpdateSchema),
  { id: true },
);
endpoint(
  "/admin/people/{id}/link",
  "post",
  "Admin: explicitly link existing profiles and select home store",
  z.toJSONSchema(personLinkSchema),
  { id: true },
);
endpoint(
  "/admin/people/{id}/candidate",
  "post",
  "Admin: explicitly link a reviewed POS candidate",
  z.toJSONSchema(candidateLinkSchema),
  { id: true },
);
await writeFile(
  "docs/openapi.json",
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "IDAD Employee Directory API",
        version: "1.0.0",
        description:
          "IDAD Admin-only employee directory API. Single-store login profiles are retired; pending assignments expose a blank POS ID and explicit pending flag.",
      },
      servers: [{ url: "http://127.0.0.1:3210/api/v1" }],
      components: {
        securitySchemes: {
          session: {
            type: "apiKey",
            in: "cookie",
            name: "idad_directory_session",
          },
          reportingToken: {
            type: "http",
            scheme: "bearer",
            description:
              "Dedicated machine credential limited to validated reporting exports.",
          },
        },
      },
      paths,
    },
    null,
    2,
  ) + "\n",
);
