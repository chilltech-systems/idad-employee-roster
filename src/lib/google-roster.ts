import { createSign } from "node:crypto";
import { googleCredential } from "./google-credential";
import { Problem, rosterSchema, type Store, type Roster } from "./model";

export const rosterSpreadsheet = "1cnwk6I56RMs0-lBc2i2j2VIM0jRcPXPHyUVZLTQ06vE";
export const rosterTab = "Employee ID Master - Import";
export const rosterRange = `'${rosterTab}'!A1:D5000`;
const headers = [
  "Store Id",
  "Employee Name",
  "Employee Number",
  "Store+Emp.ID",
];

// Only an explicit enabled-store mapping determines scope. Linked locations stay separate.
export function parseGoogleRoster(
  values: unknown,
  enabled: Store[],
  observedAt: string,
) {
  if (!Array.isArray(values) || values.length < 2 || values.length >= 5000)
    throw new Problem(
      502,
      "Roster is empty or reaches the read limit; review source coverage.",
    );
  if (JSON.stringify(values[0]) !== JSON.stringify(headers))
    throw new Problem(
      502,
      "Roster columns changed; expected Store Id, Employee Name, Employee Number, Store+Emp.ID.",
    );
  const mapping = new Map(enabled.map((s) => [s.id.toLowerCase(), s]));
  if (
    !enabled.length ||
    mapping.size !== enabled.length ||
    enabled.some((s) => s.posSource !== "Qu")
  )
    throw new Problem(
      503,
      "Configure the approved Qu store IDs before reading the live roster.",
    );
  const rows: Roster["rows"] = [];
  const seen = new Set<string>();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!Array.isArray(row))
      throw new Problem(502, `Invalid roster row ${i + 1}.`);
    if (!row.length || row.every((v) => v === "")) continue;
    if (
      row.length !== 4 ||
      row.some((v) => typeof v !== "string" || !v.trim() || v.startsWith("#"))
    )
      throw new Problem(
        502,
        `Incomplete roster row ${i + 1}; last successful roster retained.`,
      );
    const [store, name, id, compound] = row.map((v) => v.trim());
    if (compound.toLowerCase() !== `${store}+${id}`.toLowerCase())
      throw new Problem(502, `Roster identity mismatch on row ${i + 1}.`);
    const target = mapping.get(store.toLowerCase());
    if (!target) continue;
    const key = JSON.stringify([target.id, id]);
    if (seen.has(key))
      throw new Problem(502, `Duplicate roster identity on row ${i + 1}.`);
    seen.add(key);
    rows.push({
      storeId: target.id,
      posSource: target.posSource,
      posEmployeeId: id,
      posName: name,
    });
  }
  if (enabled.some((s) => !rows.some((r) => r.storeId === s.id)))
    throw new Problem(
      502,
      "Roster is missing an enabled store; last successful roster retained.",
    );
  return rosterSchema.parse({
    source: `google-sheets:${rosterSpreadsheet}:${rosterTab}`,
    complete: true,
    observedAt,
    stores: enabled.map((s) => s.id),
    rowCount: rows.length,
    rows,
  });
}

async function boundedJson(response: Response): Promise<any> {
  if (!response.ok || !response.body)
    throw new Problem(
      502,
      "Google roster read failed; check read-only access and retry.",
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2_000_000)
      throw new Problem(
        502,
        "Google roster response exceeds the allowed size.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Problem(502, "Google returned an invalid roster response.");
  }
}

export async function readGoogleRoster(
  enabled: Store[],
  request: typeof fetch = fetch,
) {
  const key = await googleCredential("roster");
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  let signature;
  try {
    signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(key.private_key, "base64url");
  } catch {
    throw new Problem(
      503,
      "The portal Google credential cannot sign requests.",
    );
  }
  const auth = await boundedJson(
    await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: unsigned + "." + signature,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }),
  );
  if (typeof auth.access_token !== "string")
    throw new Problem(502, "Google did not return an access token.");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${rosterSpreadsheet}/values/${encodeURIComponent(rosterRange)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const read = async () =>
    (
      await boundedJson(
        await request(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${auth.access_token}` },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        }),
      )
    ).values;
  const first = await read();
  const second = await read();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Problem(
      502,
      "Roster changed during refresh; retry after the upstream import finishes.",
    );
  // Matching reads detect a moving source, not upstream job completion. Coverage and
  // size-drop validation in refresh() still apply; no absence causes deactivation.
  return parseGoogleRoster(first, enabled, new Date().toISOString());
}
