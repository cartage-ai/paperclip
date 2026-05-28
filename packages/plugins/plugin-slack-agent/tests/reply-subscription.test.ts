import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { stateKey, type IssueChannelMap } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-test";
const STAN_AGENT_ID = "agent-stan";
const BOT_TOKEN = "xoxb-test-token";

const CONFIG = {
  agents: [
    {
      agentId: STAN_AGENT_ID,
      slackBotToken: BOT_TOKEN,
      slackSigningSecret: "signing-secret",
      slackBotUserId: "U_BOT",
      companyId: COMPANY_ID,
      displayName: "Stan",
    },
  ],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let harness: ReturnType<typeof createTestHarness>;
const httpFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

beforeEach(async () => {
  vi.clearAllMocks();

  harness = createTestHarness({
    manifest,
    config: CONFIG as unknown as Record<string, unknown>,
  });

  // Seed an issue and a comment from Stan
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
    issues: [
      {
        id: "issue-1",
        companyId: COMPANY_ID,
        title: "Test issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: STAN_AGENT_ID,
        description: null,
        projectId: null,
        projectWorkspaceId: null,
        goalId: null,
        parentId: null,
        workMode: "standard",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        issueNumber: null,
        identifier: null,
        originKind: "plugin:paperclip-slack-agent",
        originId: null,
        originRunId: null,
        requestDepth: 0,
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        hiddenAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
    issueComments: [
      {
        id: "comment-1",
        companyId: COMPANY_ID,
        issueId: "issue-1",
        body: "Here's what's shipping: auth and notifications.",
        authorType: "agent",
        authorAgentId: STAN_AGENT_ID,
        authorUserId: null,
        presentation: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
  });

  // Pre-seed the issue-channel map so the reply handler knows where to post
  const channelMap: IssueChannelMap = {
    "issue-1": { channelId: "C_GENERAL", threadTs: "1700000001.000100" },
  };
  harness.ctx.state.set({ scopeKind: "instance", stateKey: stateKey.issueChannelMap(STAN_AGENT_ID) }, channelMap);

  // Inject spy on http.fetch
  harness.ctx.http = { fetch: httpFetch };

  await plugin.definition.setup(harness.ctx);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issue.comment.created — reply subscription", () => {
  it("posts Stan's comment to the correct Slack thread", async () => {
    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1" },
      {
        companyId: COMPANY_ID,
        entityId: "issue-1",
        actorType: "agent",
        actorId: STAN_AGENT_ID,
      },
    );

    expect(httpFetch).toHaveBeenCalledOnce();

    const [url, init] = httpFetch.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.channel).toBe("C_GENERAL");
    expect(body.thread_ts).toBe("1700000001.000100");
    expect(body.text).toBe("Here's what's shipping: auth and notifications.");
  });

  it("does not post for comments authored by a human (actorType !== agent)", async () => {
    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1" },
      {
        companyId: COMPANY_ID,
        entityId: "issue-1",
        actorType: "user",
        actorId: "user-1",
      },
    );

    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("does not post for comments from a different agent", async () => {
    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1" },
      {
        companyId: COMPANY_ID,
        entityId: "issue-1",
        actorType: "agent",
        actorId: "agent-other",
      },
    );

    expect(httpFetch).not.toHaveBeenCalled();
  });
});
