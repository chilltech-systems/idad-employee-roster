import test from "node:test";
import assert from "node:assert/strict";
import { portalOrigin } from "../src/lib/origin";
import {
  googleCredential,
  hasGoogleCredential,
} from "../src/lib/google-credential";

test("hosted origins require HTTPS and do not trust arbitrary request hosts", () => {
  const before = { ...process.env };
  try {
    process.env.VERCEL = "1";
    process.env.VERCEL_URL = "isolated-preview.vercel.app";
    delete process.env.PORTAL_ORIGIN;
    assert.equal(portalOrigin(), "https://isolated-preview.vercel.app");
    process.env.PORTAL_ORIGIN = "https://portal.example.com";
    assert.equal(portalOrigin(), "https://portal.example.com");
    for (const bad of [
      "http://portal.example.com",
      "https://portal.example.com/path",
      "https://user:secret@portal.example.com",
      "https://portal.example.com/",
    ]) {
      process.env.PORTAL_ORIGIN = bad;
      assert.throws(portalOrigin, /origin is not configured/);
    }
    delete process.env.PORTAL_ORIGIN;
    delete process.env.VERCEL_URL;
    assert.throws(portalOrigin, /origin is not configured/);
  } finally {
    process.env = before;
  }
});

test("hosted Google credentials are purpose-specific, sanitized and never read local files", async () => {
  const before = { ...process.env };
  try {
    process.env.VERCEL = "1";
    delete process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.PORTAL_GOOGLE_DRAFT_SERVICE_ACCOUNT_JSON;
    process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_FILE =
      "/private/not-uploaded.json";
    assert.equal(hasGoogleCredential("roster"), false);
    await assert.rejects(googleCredential("roster"), /missing or invalid/);
    process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: "service_account",
      client_email: "test@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----fictional",
    });
    assert.equal(hasGoogleCredential("roster"), true);
    assert.equal(
      (await googleCredential("roster")).client_email,
      "test@example.iam.gserviceaccount.com",
    );
    assert.equal(hasGoogleCredential("draft"), false);
    process.env.PORTAL_GOOGLE_SERVICE_ACCOUNT_JSON =
      "PRIVATE_SECRET_INVALID_JSON";
    await assert.rejects(
      googleCredential("roster"),
      (e: Error) =>
        !e.message.includes("PRIVATE_SECRET") &&
        e.message.includes("missing or invalid"),
    );
  } finally {
    process.env = before;
  }
});
