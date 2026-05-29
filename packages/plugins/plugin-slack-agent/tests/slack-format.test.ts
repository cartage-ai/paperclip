import { describe, expect, it } from "vitest";
import { buildSlackMessagePayload, markdownToSlackMrkdwn } from "../src/slack-format.js";

describe("slack formatting", () => {
  it("converts common markdown to Slack mrkdwn", () => {
    const result = markdownToSlackMrkdwn([
      "Let's scope the **OGRE integration**.",
      "",
      "- **What is OGRE?**",
      "- See [docs](https://example.com/docs).",
    ].join("\n"));

    expect(result).toContain("*OGRE integration*");
    expect(result).toContain("• *What is OGRE?*");
    expect(result).toContain("<https://example.com/docs|docs>");
    expect(result).not.toContain("**OGRE integration**");
  });

  it("preserves fenced code blocks", () => {
    const result = markdownToSlackMrkdwn("Before\n```json\n{\"x\": true}\n```\nAfter **bold**");

    expect(result).toContain("```json\n{\"x\": true}\n```");
    expect(result).toContain("After *bold*");
  });

  it("builds block kit sections with fallback text", () => {
    const payload = buildSlackMessagePayload("Hello **Stan**\n\nSecond paragraph");

    expect(payload.text).toContain("Hello *Stan*");
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: expect.stringContaining("Second paragraph") },
    });
  });
});
