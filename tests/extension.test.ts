import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import parallaxPi, { activeToolsForMode } from "../extensions/parallax/index.js";

const horizonTools = [
  "parallax_horizon_advance",
  "parallax_horizon_session",
  "parallax_horizon_plan",
  "parallax_horizon_memory",
];

describe("Pi mode tool activation", () => {
  it("keeps the build surface minimal after leaving Horizon", () => {
    const active = activeToolsForMode(["read", "write", "parallax_delegate", "parallax_hyperplan", ...horizonTools], "build");
    expect(active).toEqual(["read", "write", "parallax"]);
  });

  it("activates only the tools relevant to each supervisor mode", () => {
    expect(activeToolsForMode(["read"], "plan")).toEqual(["read", "parallax", "parallax_delegate", "parallax_hyperplan"]);
    expect(activeToolsForMode(["read"], "debug")).toEqual(["read", "parallax", "parallax_delegate"]);
    expect(activeToolsForMode(["read"], "horizon")).toEqual([
      "read",
      "parallax",
      "parallax_delegate",
      "parallax_hyperplan",
      ...horizonTools,
    ]);
  });
});

describe("Parallax extension gates", () => {
  it("gates shell mutations and returns batched verification to the next model turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "parallax-extension-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }));
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    let activeTools = ["read", "write", "edit", "bash"];
    const sendMessage = vi.fn();
    const exec = vi.fn(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      getActiveTools: () => activeTools,
      setActiveTools: (next: string[]) => { activeTools = next; },
      appendEntry: () => undefined,
      getThinkingLevel: () => "high",
      exec,
      sendMessage,
    } as unknown as ExtensionAPI;
    parallaxPi(pi);

    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [], getSessionId: () => "test-session" },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => undefined,
        setWidget: () => undefined,
        notify: () => undefined,
        confirm: async () => true,
      },
      signal: new AbortController().signal,
    } as unknown as ExtensionContext;
    const emit = async (name: string, event: unknown): Promise<unknown> => {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    };

    try {
      await emit("session_start", { reason: "startup" });
      const mutation = { toolName: "bash", input: { command: "node -e \"require('fs').writeFileSync('x','y')\"" } };
      expect(await emit("tool_call", mutation)).toMatchObject({ block: true });

      const core = tools.get("parallax")!;
      for (const [step, evidence] of [
        ["ambiguity", "LOW: exact mutation is known"],
        ["invariants", "Project files are the source of truth"],
        ["gate", "npm run check must pass"],
      ]) {
        await core.execute("id", { action: "checkin", step, evidence }, undefined, undefined, ctx);
      }
      const prematureCommit = await core.execute("id", { action: "checkin", step: "commit", evidence: "Full solution selected" }, undefined, undefined, ctx);
      expect(JSON.stringify(prematureCommit)).toContain("requires a passing verification");

      expect(await emit("tool_call", mutation)).toBeUndefined();
      await emit("tool_result", { ...mutation, isError: false });
      await emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] });

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "parallax-verification", content: expect.stringContaining("PASS") }),
        { deliverAs: "steer" },
      );
      const verifiedCommit = await core.execute("id", { action: "checkin", step: "commit", evidence: "Full solution selected" }, undefined, undefined, ctx);
      expect(JSON.stringify(verifiedCommit)).toContain("commit marked complete");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
