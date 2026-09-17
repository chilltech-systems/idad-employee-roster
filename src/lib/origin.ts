import { Problem } from "./model";

export function portalOrigin() {
  const configured = process.env.PORTAL_ORIGIN;
  const generated = process.env.VERCEL_URL;
  const value =
    configured ||
    (process.env.VERCEL && generated
      ? `https://${generated}`
      : "http://127.0.0.1:3210");
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) throw new Error();
    if (process.env.VERCEL && url.protocol !== "https:") throw new Error();
    if (!process.env.VERCEL && !["https:", "http:"].includes(url.protocol))
      throw new Error();
    return url.origin;
  } catch {
    throw new Problem(503, "Portal origin is not configured correctly.");
  }
}
