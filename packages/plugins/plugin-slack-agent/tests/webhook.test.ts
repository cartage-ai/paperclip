import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { SlackAgentPluginConfig } from "../src/constants.js";
import { stateKey } from "../src/constants.js";

vi.mock("pdf-parse", () => ({
  default: vi.fn().mockResolvedValue({ text: "mock extracted pdf text", numpages: 1 }),
}));

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

  it("dedupes distinct Slack events for the same message timestamp", async () => {
    const firstBody = appMentionBody({ event_id: "Ev_same_message_1" }) as Record<string, unknown>;
    const secondBody = appMentionBody({ event_id: "Ev_same_message_2" }) as Record<string, unknown>;

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(firstBody), firstBody));
    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(secondBody), secondBody));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(Object.keys(threadMap ?? {})).toHaveLength(1);
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

  it("reopens a done chat issue before waking the agent for a Slack continuation", async () => {
    const firstBody = appMentionBody({ event_id: "Ev_done_first" });
    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(firstBody), firstBody));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    const issueId = Object.values(threadMap!)[0]!;
    await harness.ctx.issues.update(issueId, { status: "done" }, COMPANY_ID);

    const continuationBody = {
      type: "event_callback",
      event_id: "Ev_done_reply",
      event: {
        type: "app_mention",
        user: "U_HUMAN",
        text: "Would love to plan a migration with you",
        ts: "1700000002.000200",
        channel: "C_GENERAL",
        channel_type: "channel",
        thread_ts: "1700000001.000100",
      },
      team_id: "T_TEAM",
    };
    const continuationRaw = JSON.stringify(continuationBody);

    await plugin.definition.onWebhook!(makeWebhookInput(continuationRaw, continuationBody));
    await plugin.definition.onWebhook!(makeWebhookInput(continuationRaw, continuationBody));

    const issue = await harness.ctx.issues.get(issueId, COMPANY_ID);
    expect(issue?.status).toBe("todo");

    const comments = await harness.ctx.issues.listComments(issueId, COMPANY_ID);
    const continuationComments = comments.filter((comment) => comment.body === "Would love to plan a migration with you");
    expect(continuationComments).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// File attachment helpers
// ---------------------------------------------------------------------------

type SlackFileFixture = {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download: string;
};

function appMentionWithFiles(files: SlackFileFixture[], overrides?: Record<string, unknown>): unknown {
  const ts = Math.floor(Date.now() / 1000);
  return {
    type: "event_callback",
    event_id: `Ev${ts}`,
    event: {
      type: "app_mention",
      user: "U_HUMAN",
      text: "<@U_BOT> check this file",
      ts: "1700000020.000100",
      channel: "C_GENERAL",
      channel_type: "channel",
      files,
    },
    team_id: "T_TEAM",
    ...overrides,
  };
}

function makeFileFetch(fileResponses: Record<string, string | Uint8Array>) {
  return async (url: string, _init?: RequestInit): Promise<Response> => {
    for (const [pattern, content] of Object.entries(fileResponses)) {
      if (url.includes(pattern)) {
        return new Response(content, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// File attachment tests
// ---------------------------------------------------------------------------

describe("onWebhook — file attachments", () => {
  // Tracer bullet: PDF on new mention → document upserted
  it("ingests a PDF attachment → document upserted with extracted text", async () => {
    const file: SlackFileFixture = {
      id: "F_PDF1",
      name: "spec.pdf",
      mimetype: "application/pdf",
      size: 1024,
      url_private_download: "https://files.slack.com/files-pri/spec.pdf",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_pdf1" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = { fetch: makeFileFetch({ "spec.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    expect(upsertSpy).toHaveBeenCalledOnce();
    const call = upsertSpy.mock.calls[0]![0];
    expect(call.key).toBe("slack-attachment-spec-pdf-f-pdf1");
    expect(call.body).toBe("mock extracted pdf text");
    expect(call.title).toBe("spec.pdf");
  });

  it("ingests a text/plain attachment on continuation → upserted on existing issue", async () => {
    // First message — creates the issue
    harness.ctx.http = { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    const firstBody = appMentionBody({ event_id: "Ev_cont_base" });
    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(firstBody), firstBody));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string>;
    const issueId = Object.values(threadMap)[0]!;

    // Continuation with a text file in same thread
    const file: SlackFileFixture = {
      id: "F_TXT1",
      name: "notes.txt",
      mimetype: "text/plain",
      size: 512,
      url_private_download: "https://files.slack.com/files-pri/notes.txt",
    };
    const contBody = {
      type: "event_callback",
      event_id: "Ev_cont_file",
      event: {
        type: "app_mention",
        user: "U_HUMAN",
        text: "here are my notes",
        ts: "1700000021.000100",
        channel: "C_GENERAL",
        channel_type: "channel",
        thread_ts: "1700000001.000100",
        files: [file],
      },
      team_id: "T_TEAM",
    };
    harness.ctx.http = { fetch: makeFileFetch({ "notes.txt": "hello world notes text" }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(contBody), contBody));

    expect(upsertSpy).toHaveBeenCalledOnce();
    const call = upsertSpy.mock.calls[0]![0];
    expect(call.issueId).toBe(issueId);
    expect(call.key).toBe("slack-attachment-notes-txt-f-txt1");
    expect(call.body).toBe("hello world notes text");
  });

  it("multi-file: two valid files → two documents upserted", async () => {
    const files: SlackFileFixture[] = [
      { id: "F_M1", name: "a.txt", mimetype: "text/plain", size: 100, url_private_download: "https://files.slack.com/a.txt" },
      { id: "F_M2", name: "b.txt", mimetype: "text/plain", size: 200, url_private_download: "https://files.slack.com/b.txt" },
    ];
    const body = appMentionWithFiles(files, { event_id: "Ev_multi" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = { fetch: makeFileFetch({ "a.txt": "content a", "b.txt": "content b" }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    const keys = upsertSpy.mock.calls.map((c) => c[0].key);
    expect(keys).toContain("slack-attachment-a-txt-f-m1");
    expect(keys).toContain("slack-attachment-b-txt-f-m2");
  });

  it("skips already-ingested Slack files so duplicate deliveries do not update documents", async () => {
    const file: SlackFileFixture = {
      id: "F_DUP1",
      name: "spec.pdf",
      mimetype: "application/pdf",
      size: 1024,
      url_private_download: "https://files.slack.com/files-pri/spec.pdf",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_dup_file" });
    harness.ctx.http = { fetch: makeFileFetch({ "spec.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }) };

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(body), body));

    const duplicateBody = appMentionWithFiles([file], {
      event_id: "Ev_dup_file_retry",
      event: { ...(body as { event: object }).event, ts: "1700000020.000101", thread_ts: "1700000020.000100" },
    });
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(duplicateBody), duplicateBody));

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("messy filename (spaces, parens, dots, caps) → key passes issueDocumentKeySchema", async () => {
    const file: SlackFileFixture = {
      id: "F_OGRE1",
      name: "OGRE_API_Integration_Guide (1) (1).pdf",
      mimetype: "application/pdf",
      size: 4096,
      url_private_download: "https://files.slack.com/files-pri/ogre.pdf",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_ogre" });
    harness.ctx.http = { fetch: makeFileFetch({ "OGRE_API_Integration_Guide (1) (1).pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(body), body));

    expect(upsertSpy).toHaveBeenCalledOnce();
    const { key } = upsertSpy.mock.calls[0]![0];
    expect(key).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key).toContain("f-ogre1");
  });

  it("image file → visible image attachment document and comment logged", async () => {
    const file: SlackFileFixture = {
      id: "F_IMG1",
      name: "screenshot.png",
      mimetype: "image/png",
      size: 4096,
      url_private_download: "https://files.slack.com/screenshot.png",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_image" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");
    const commentSpy = vi.spyOn(harness.ctx.issues, "createComment");

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0]![0]).toMatchObject({
      key: "slack-attachment-screenshot-png-f-img1",
      title: "screenshot.png",
      body: expect.stringContaining("Slack image attachment: screenshot.png"),
    });
    const imageComment = commentSpy.mock.calls.find(([, b]) => b.includes("Image attached") && b.includes("screenshot.png"));
    expect(imageComment).toBeDefined();
  });

  it("oversized file → skip comment logged, no document upserted", async () => {
    const file: SlackFileFixture = {
      id: "F_BIG1",
      name: "bigfile.pdf",
      mimetype: "application/pdf",
      size: 11 * 1024 * 1024,
      url_private_download: "https://files.slack.com/bigfile.pdf",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_oversized" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");
    const commentSpy = vi.spyOn(harness.ctx.issues, "createComment");

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    expect(upsertSpy).not.toHaveBeenCalled();
    const skipComment = commentSpy.mock.calls.find(([, b]) => b.includes("bigfile.pdf"));
    expect(skipComment).toBeDefined();
  });

  it("download failure → error comment logged, other files still processed", async () => {
    const failFile: SlackFileFixture = {
      id: "F_FAIL",
      name: "fail.pdf",
      mimetype: "application/pdf",
      size: 1024,
      url_private_download: "https://files.slack.com/fail.pdf",
    };
    const goodFile: SlackFileFixture = {
      id: "F_GOOD",
      name: "good.txt",
      mimetype: "text/plain",
      size: 100,
      url_private_download: "https://files.slack.com/good.txt",
    };
    const body = appMentionWithFiles([failFile, goodFile], { event_id: "Ev_dlFail" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = {
      fetch: async (url: string) => {
        if (url.includes("fail.pdf")) return new Response("Not Found", { status: 404 });
        if (url.includes("good.txt")) return new Response("good content", { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };
    const upsertSpy = vi.spyOn(harness.ctx.issues.documents, "upsert");
    const commentSpy = vi.spyOn(harness.ctx.issues, "createComment");

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0]![0].key).toContain("good-txt");
    const errComment = commentSpy.mock.calls.find(([, b]) => b.includes("fail.pdf"));
    expect(errComment).toBeDefined();
  });

  it("file-only message → creates a non-empty comment and wakeup fires", async () => {
    const file: SlackFileFixture = {
      id: "F_ONLY_IMAGE",
      name: "diagram.png",
      mimetype: "image/png",
      size: 256,
      url_private_download: "https://files.slack.com/diagram.png",
    };
    const body = appMentionWithFiles([file], {
      event_id: "Ev_file_only",
      event: {
        type: "app_mention",
        user: "U_HUMAN",
        text: "",
        ts: "1700000030.000100",
        channel: "C_GENERAL",
        channel_type: "channel",
        files: [file],
      },
    });
    const rawBody = JSON.stringify(body);

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    const issueId = Object.values(threadMap!)[0]!;
    const comments = await harness.ctx.issues.listComments(issueId, COMPANY_ID);
    expect(comments.some((comment) => comment.body === "[Slack message with 1 attachment]")).toBe(true);
  });

  it("file attachment with text message → wakeup fires and issue created", async () => {
    const file: SlackFileFixture = {
      id: "F_WAKE1",
      name: "brief.md",
      mimetype: "text/markdown",
      size: 256,
      url_private_download: "https://files.slack.com/brief.md",
    };
    const body = appMentionWithFiles([file], { event_id: "Ev_wake" });
    const rawBody = JSON.stringify(body);

    harness.ctx.http = { fetch: makeFileFetch({ "brief.md": "## Brief\n\nDo the thing." }) };

    await plugin.definition.onWebhook!(makeWebhookInput(rawBody, body));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(threadMap).not.toBeNull();
    expect(Object.keys(threadMap!)).toHaveLength(1);
  });

  it("creates an issue for a file_share channel message that mentions the bot", async () => {
    const file: SlackFileFixture = {
      id: "F_SHARE1",
      name: "OGRE_API_Integration_Guide (1) (1).pdf",
      mimetype: "application/pdf",
      size: 4096,
      url_private_download: "https://files.slack.com/files-pri/ogre.pdf",
    };
    const body = {
      type: "event_callback",
      event_id: "Ev_file_share_mention",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U_HUMAN",
        text: "Hey <@U_BOT> do you see this file?",
        ts: "1700000040.000100",
        channel: "C_GENERAL",
        channel_type: "channel",
        files: [file],
      },
      team_id: "T_TEAM",
    };

    harness.ctx.http = { fetch: makeFileFetch({ "ogre.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }) };

    await plugin.definition.onWebhook!(makeWebhookInput(JSON.stringify(body), body));

    const threadMap = harness.getState({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(STAN_AGENT_ID) }) as Record<string, string> | null;
    expect(threadMap).not.toBeNull();
    expect(Object.keys(threadMap!)).toHaveLength(1);
  });
});
