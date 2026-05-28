import { describe, it, expect } from "vitest";
import {
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("maps ceo role to ceo", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("maps unknown role to default", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("unknown")).toBe("default");
  });

  it("maps stan role to default — stan definition is external, not baked in the image", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("stan")).toBe("default");
  });
});
