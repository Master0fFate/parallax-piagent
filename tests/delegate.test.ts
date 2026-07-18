import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { agentCanMutate, discoverDelegateAgents, runDelegates } from "../src/delegate.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-delegate-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("delegate agent discovery", () => {
  it("identifies workers that could bypass parent verification", () => {
    expect(agentCanMutate({ tools: ["read", "edit"] })).toBe(true);
    expect(agentCanMutate({ tools: ["read", "grep"] })).toBe(false);
  });

  it("loads the five packaged roles", async () => {
    const agents = await discoverDelegateAgents(await temp(), "builtin", false);
    expect(agents.map((agent) => agent.name).sort()).toEqual(["critic", "planner", "reviewer", "scout", "worker"]);
    expect(agents.find((agent) => agent.name === "worker")?.tools).toContain("edit");
    expect(agents.find((agent) => agent.name === "scout")?.tools).not.toContain("edit");
  });

  it("refuses project agents before trust", async () => {
    await expect(discoverDelegateAgents(await temp(), "project", false)).rejects.toThrow("trusted");
  });

  it("refuses delegated sessions before project trust", async () => {
    await expect(runDelegates("single", [{ agent: "scout", task: "inspect" }], {
      cwd: await temp(),
      model: {} as Model<any>,
      thinkingLevel: "high",
      scope: "builtin",
      projectTrusted: false,
    })).rejects.toThrow("trusted Pi project");
  });

  it("allows trusted project agents to override built-ins", async () => {
    const dir = await temp();
    const agentsDir = join(dir, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: Project worker\ntools: read\n---\nProject rules.");
    const agents = await discoverDelegateAgents(dir, "all", true);
    const worker = agents.find((agent) => agent.name === "worker");
    expect(worker?.source).toBe("project");
    expect(worker?.tools).toEqual(["read"]);
  });

  it("ignores malformed optional definitions", async () => {
    const dir = await temp();
    const agentsDir = join(dir, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "bad.md"), "No frontmatter");
    expect(await discoverDelegateAgents(dir, "project", true)).toEqual([]);
  });
});
