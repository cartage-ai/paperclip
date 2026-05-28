import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../src/slack-verify.js";

function makeSignature(secret: string, ts: number, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
}

function makeHeaders(secret: string, ts: number, rawBody: string): Record<string, string> {
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": makeSignature(secret, ts, rawBody),
  };
}

const SECRET = "test-signing-secret";
const BODY = '{"type":"event_callback"}';
const NOW = 1700000000;

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    const headers = makeHeaders(SECRET, NOW, BODY);
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = makeHeaders(SECRET, NOW, BODY);
    expect(verifySlackSignature(BODY + " tampered", headers, SECRET, NOW)).toBe(false);
  });

  it("rejects a wrong signing secret", () => {
    const headers = makeHeaders("wrong-secret", NOW, BODY);
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(false);
  });

  it("rejects an expired timestamp (>5 minutes old)", () => {
    const staleTs = NOW - 310; // 310s ago > 300s window
    const headers = makeHeaders(SECRET, staleTs, BODY);
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(false);
  });

  it("accepts a timestamp within the 5-minute tolerance window", () => {
    const recentTs = NOW - 240; // 240s ago, within 300s window
    const headers = makeHeaders(SECRET, recentTs, BODY);
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(true);
  });

  it("rejects missing x-slack-signature header", () => {
    const headers = { "x-slack-request-timestamp": String(NOW) };
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(false);
  });

  it("rejects missing x-slack-request-timestamp header", () => {
    const headers = { "x-slack-signature": makeSignature(SECRET, NOW, BODY) };
    expect(verifySlackSignature(BODY, headers, SECRET, NOW)).toBe(false);
  });
});
