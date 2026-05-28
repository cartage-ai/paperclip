import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(), upgrade: vi.fn() }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getById: vi.fn(), assertCheckoutOwner: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const PLUGIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeReadyPlugin() {
  return {
    id: PLUGIN_ID,
    pluginKey: "paperclip-slack-agent",
    status: "ready",
    manifestJson: {
      id: "paperclip-slack-agent",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Slack Agent",
      description: "Test",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["webhooks.receive"],
      entrypoints: { worker: "dist/worker.js" },
      webhooks: [{ endpointKey: "slack-events", displayName: "Slack Events", description: "" }],
    },
  };
}

async function createApp(workerCall?: ReturnType<typeof vi.fn>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: workerCall ?? vi.fn().mockResolvedValue(undefined),
  };

  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use((req, _res, next) => {
    req.actor = { type: "unauthenticated" } as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      { workerManager } as never,
      undefined,
      undefined,
    ),
  );
  app.use(errorHandler);

  return { app, workerManager };
}

describe.sequential("plugin webhook — Slack url_verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(makeReadyPlugin());
    mockRegistry.getByKey.mockResolvedValue(makeReadyPlugin());
  });

  it("echoes the challenge immediately and does not dispatch to the plugin worker", async () => {
    const workerCall = vi.fn().mockResolvedValue(undefined);
    const { app } = await createApp(workerCall);

    const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "url_verification", challenge, token: "Jhj5dZrVaK7ZwHHjRyZWjbDl" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge });
    expect(workerCall).not.toHaveBeenCalled();
  });

  it("does not short-circuit for non-url_verification bodies (passes through to normal route path)", async () => {
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "event_callback", event_id: "Ev123" });

    // Normal route path attempts DB insert which fails without a DB (500),
    // confirming the url_verification early-return did NOT trigger.
    expect(res.body).not.toHaveProperty("challenge");
    expect(res.status).not.toBe(200);
  });
});
