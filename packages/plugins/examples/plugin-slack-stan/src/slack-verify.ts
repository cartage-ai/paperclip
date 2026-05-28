import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_WINDOW_SECONDS = 300;

function firstHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Verifies that an inbound Slack request was signed by the expected app.
 *
 * Precondition: rawBody is the unmodified UTF-8 request body.
 * Postcondition: returns true only when signature is valid and timestamp is fresh.
 *
 * @param nowSeconds - seconds since epoch; injectable for testing (defaults to Date.now()/1000)
 */
export function verifySlackSignature(
  rawBody: string,
  headers: Record<string, string | string[]>,
  signingSecret: string,
  nowSeconds?: number,
): boolean {
  const tsString = firstHeader(headers, "x-slack-request-timestamp");
  const receivedSig = firstHeader(headers, "x-slack-signature");

  if (!tsString || !receivedSig) return false;

  const ts = Number(tsString);
  if (!Number.isFinite(ts)) return false;

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SIGNATURE_WINDOW_SECONDS) return false;

  const baseString = `v0:${ts}:${rawBody}`;
  const expectedHex = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  const expected = Buffer.from(`v0=${expectedHex}`, "utf8");

  const received = Buffer.from(receivedSig, "utf8");
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
