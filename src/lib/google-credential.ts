import { readFile } from "node:fs/promises";
import { Problem } from "./model";

type Purpose = "roster" | "draft";
const prefix = (purpose: Purpose) =>
  purpose === "draft"
    ? "PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT"
    : "PORTAL_GOOGLE_SERVICE_ACCOUNT";

export function hasGoogleCredential(purpose: Purpose) {
  const name = prefix(purpose);
  return !!(
    process.env[`${name}_JSON`] ||
    (!process.env.VERCEL && process.env[`${name}_FILE`])
  );
}

// Server-only environment values are never included in responses or diagnostics.
// Hosted deployments cannot depend on a credential file on the owner's Mac.
export async function googleCredential(purpose: Purpose) {
  const name = prefix(purpose);
  try {
    let raw = process.env[`${name}_JSON`];
    if (!raw && !process.env.VERCEL && process.env[`${name}_FILE`])
      raw = await readFile(process.env[`${name}_FILE`]!, "utf8");
    if (!raw || raw.length > 32000) throw new Error();
    const key = JSON.parse(raw);
    if (
      key?.type !== "service_account" ||
      typeof key.client_email !== "string" ||
      !key.client_email.includes("@") ||
      typeof key.private_key !== "string" ||
      !key.private_key.includes("-----BEGIN PRIVATE KEY-----")
    )
      throw new Error();
    return key as {
      type: "service_account";
      client_email: string;
      private_key: string;
    };
  } catch {
    throw new Problem(
      503,
      `The ${purpose} Google credential is missing or invalid.`,
    );
  }
}
