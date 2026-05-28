import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { SlackAgentPluginConfig } from "../src/constants.js";
import { stateKey } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-test";
const STAN_AGENT_ID = "agent-stan";
const BOT_USER_ID = "U_BOT";
const SIGNING_SECRET = "test-slack-signing-secret";
const BOT_TOKEN = "xoxb-test-token";

const CONFIG: SlackAgentPluginConfig = {
  agents: [
    {
      agentId: STAN_AGENT_ID,
      slackBotToken: BOT_TOKEN,
      slackSigningSecret: SIGNING_SECRET,
      slackBotUserId: BOT_USER_ID,
      companyId: COMPANY_ID,
      displayName: "Stan",
    },
  ],
};

function sign(rawBody: string, ts: number, secret: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
}

function makeWebhookInput(rawBody: string, parsedBody: unknown, nowTs = Math.floor(Date.now() / 1000)): PluginWebhookInput {
  return {
    endpointKey: "slack-events",
    requestId: "req-1",
    rawBody,
    parsedBody,
    headers: {
      "x-slack-request-timestamp": String(nowTs),
      "x-slack-signature": sign(rawBody, nowTs, SIGNING_SECRET),
    },
  };
}

function appMentionBody(overrides?: object): unknown {
  const ts = Math.floor(Date.now() / 1000);
  return {
    type: "event_callback",
    event_id: `Ev${ts}`,
    event: {
      type: "app_mention",
      user: "U_HUMAN",
      text: "<@U_BOT> what's the status of auth?",
      ts: "1700000001.000100",
      channel: "C_GENERAL",
      channel_type: "channel",
    },
    team_id: "T_TEAM",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let harness: ReturnType<typeof createTestHarness>;

beforeEach(async () => {
  harness = createTestHarness({
    manifest,
    config: CONFIG as unknown as Record<string, unknown>,
  });

  // Seed Stan agent (requestWakeup requires an assigned agent)
  harness.seed({
    agents: [
      {
        id: STAN_AGENT_ID,
        companyId: COMPANY_ID,
        name: "Stan",
        status: "active",
        role: "stan",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
  });

  // Override http.fetch to a no-op so Slack API calls don't go out
  harness.ctx.http = {
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  };

  await plugin.definition.setup(harness.ctx);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onWebhook — slack-events", () => {
  it("throws on forged signature (HMAC mismatch)", async () => {
    const rawBody = JSON.stringify(appMentionBody());
    const nowTs = Math.floor(Date.now() / 1000);
    const input: PluginWebhookInput = {
      endpointKey: "slack-events",
      requestId: "req-forged",
      rawBody,
      parsedBody: JSON.parse(rawBody),
      headers: {
        "x-slack-request-timestamp": String(nowTs),
        "x-slack-signature": "v0=badbadbadbad",
      },
    };

    await expect(plugin.definition.onWebhook!(input)).rejects.toThrow("Slack signature verification failed — no registered agent matched");
  });

  it("returns without creating an issue for a URL verification challenge", async () => {
    const body = { type: "url_verification", challenge: "abc123" };
    const rawBody = JSON.stringify(body);
    const input = makeWebhookInput(rawBody, body);

    await plugin.definition.onWebhook!(input);

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) });
    expect(threadMap == null).toBe(true);
  });

  it("ignores a duplicate event_id (dedupe)", async () => {
    const body = appMentionBody() as Record<string, unknown>;
    const rawBody = JSON.stringify(body);
    const input = makeWebhookInput(rawBody, body);

    await plugin.definition.onWebhook!(input);
    await plugin.definition.onWebhook!(input); // second delivery — same event_id

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    const issueCount = Object.keys(threadMap ?? {}).length;
    expect(issueCount).toBe(1); // only one issue created despite two deliveries
  });

  it("does not mark an event seen when processing throws, so the retry reprocesses", async () => {
    const body = appMentionBody({ event_id: "Ev_transient" }) as Record<string, unknown>;
    const rawBody = JSON.stringify(body);
    const input = makeWebhookInput(rawBody, body);

    // Fail the first delivery mid-processing (e.g. worker mid-restart / transient).
    const realCreate = harness.ctx.issues!.create.bind(harness.ctx.issues);
    let failNext = true;
    harness.ctx.issues!.create = (async (...args: Parameters<typeof realCreate>) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient failure");
      }
      return realCreate(...args);
    }) as typeof realCreate;

    await expect(plugin.definition.onWebhook!(input)).rejects.toThrow("transient failure");

    const afterFail = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) });
    expect(afterFail == null).toBe(true); // nothing created on the failed delivery

    // Slack retries the same event_id — it must NOT be deduped away.
    await plugin.definition.onWebhook!(input);

    const afterRetry = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(afterRetry).not.toBeNull();
    expect(Object.keys(afterRetry!)).toHaveLength(1);
  });

  it("ignores self-messages from the bot user", async () => {
    const body = appMentionBody({ event: { type: "app_mention", user: BOT_USER_ID, text: "hi", ts: "1700000001.000100", channel: "C_GEN", channel_type: "channel" } });
    const rawBody = JSON.stringify(body);
    const input = makeWebhookInput(rawBody, body);

    await plugin.definition.onWebhook!(input);

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) });
    expect(threadMap == null).toBe(true);
  });

  it("creates an issue + requests wakeup on a new app_mention", async () => {
    const body = appMentionBody();
    const rawBody = JSON.stringify(body);
    const input = makeWebhookInput(rawBody, body);

    await plugin.definition.onWebhook!(input);

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(threadMap).not.toBeNull();
    const issueIds = Object.values(threadMap!);
    expect(issueIds).toHaveLength(1);
  });

  it("creates a comment + wakeup on a continuation in a tracked thread", async () => {
    // First message — creates the issue
    const firstBody = appMentionBody({ event_id: "Ev_first" });
    const firstRaw = JSON.stringify(firstBody);
    await plugin.definition.onWebhook!(makeWebhookInput(firstRaw, firstBody));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    const issueId = Object.values(threadMap!)[0]!;

    // Second message in the same thread
    const continuationBody = {
      type: "event_callback",
      event_id: "Ev_reply",
      event: {
        type: "app_mention",
        user: "U_HUMAN",
        text: "follow-up question",
        ts: "1700000002.000200",
        channel: "C_GENERAL",
        channel_type: "channel",
        thread_ts: "1700000001.000100", // same thread
      },
      team_id: "T_TEAM",
    };
    const continuationRaw = JSON.stringify(continuationBody);
    await plugin.definition.onWebhook!(makeWebhookInput(continuationRaw, continuationBody));

    const comments = harness.ctx.issues ? await harness.ctx.issues.listComments(issueId, COMPANY_ID) : [];
    expect(comments.length).toBeGreaterThanOrEqual(1);
  });

  it("creates an issue + wakeup on a DM", async () => {
    const dmBody = {
      type: "event_callback",
      event_id: "Ev_dm",
      event: {
        type: "message",
        user: "U_HUMAN",
        text: "hey Stan, what's shipping this week?",
        ts: "1700000003.000300",
        channel: "D_DM_CHANNEL",
        channel_type: "im",
      },
      team_id: "T_TEAM",
    };
    const rawBody = JSON.stringify(dmBody);
    const input = makeWebhookInput(rawBody, dmBody);

    await plugin.definition.onWebhook!(input);

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(threadMap).not.toBeNull();
    expect(Object.keys(threadMap!)).toHaveLength(1);
    expect(Object.keys(threadMap!)[0]).toMatch(/^dm:/);
  });
});
