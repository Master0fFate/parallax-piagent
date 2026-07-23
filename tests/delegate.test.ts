import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { agentCanMutate, createProjectDelegateAgent, discoverDelegateAgents, resolveDelegateCwd, runDelegates, selectDelegateModel } from "../src/delegate.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-delegate-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function model(id: string, cost: number, contextWindow = 128_000): Model<any> {
  return {
    id,
    name: id,
    provider: "test-provider",
    api: "openai-completions",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 16_384,
  } as Model<any>;
}

describe("delegate agent discovery", () => {
  it("identifies workers that could bypass parent verification", () => {
    expect(agentCanMutate({ tools: ["read", "edit"] })).toBe(true);
    expect(agentCanMutate({ tools: ["read", "grep"] })).toBe(false);
  });

  it("routes inexpensive reconnaissance roles to the cheapest qualified model from the parent provider", () => {
    const active = model("premium", 20);
    const efficient = model("efficient", 1);
    expect(selectDelegateModel({ name: "scout" }, active, [active, efficient]).id).toBe("efficient");
    expect(selectDelegateModel({ name: "critic" }, active, [active, efficient]).id).toBe("efficient");
    expect(selectDelegateModel({ name: "reviewer" }, active, [active, efficient]).id).toBe("premium");
  });

  it("allows an exact configured model only from the authenticated parent provider", () => {
    const active = model("premium", 20);
    const efficient = model("efficient", 1);
    expect(selectDelegateModel({ name: "reviewer", model: "efficient" }, active, [active, efficient]).id).toBe("efficient");
    expect(() => selectDelegateModel({ name: "reviewer", model: "other-provider/efficient" }, active, [active, efficient]))
      .toThrow("parent provider");
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

  it("confines delegate working directories to the trusted project", async () => {
    const dir = await temp();
    const nested = join(dir, "packages", "feature");
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir, "not-a-directory"), "x");

    expect(await resolveDelegateCwd(dir)).toBe(await realpath(dir));
    expect(await resolveDelegateCwd(dir, "packages/feature")).toBe(await realpath(nested));
    await expect(resolveDelegateCwd(dir, "..")).rejects.toThrow("trusted project directory");
    await expect(resolveDelegateCwd(dir, "not-a-directory")).rejects.toThrow("not a directory");
  });

  it("resolves delegate working directories from the repository root", async () => {
    const dir = await temp();
    const launchDir = join(dir, "packages", "api");
    const sibling = join(dir, "packages", "web");
    await mkdir(join(dir, ".git"));
    await mkdir(launchDir, { recursive: true });
    await mkdir(sibling, { recursive: true });

    expect(await resolveDelegateCwd(launchDir, "packages/web")).toBe(await realpath(sibling));
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

  it("loads .parallax agents after legacy .pi agents so project roles can override them", async () => {
    const dir = await temp();
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await mkdir(join(dir, ".parallax", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", "auditor.md"), "---\nname: auditor\ndescription: Legacy auditor\ntools: read\n---\nLegacy rules.");
    await writeFile(join(dir, ".parallax", "agents", "auditor.md"), "---\nname: auditor\ndescription: Parallax auditor\ntools: read, grep\n---\nCurrent rules.");

    const auditor = (await discoverDelegateAgents(dir, "project", true)).find((agent) => agent.name === "auditor");
    expect(auditor?.description).toBe("Parallax auditor");
    expect(auditor?.filePath).toBe(join(dir, ".parallax", "agents", "auditor.md"));
  });

  it("creates reusable, read-only project agents from unknown role names", async () => {
    const dir = await temp();
    const created = await createProjectDelegateAgent(dir, "Security Boundary Auditor");
    const definition = await readFile(join(dir, ".parallax", "agents", "security-boundary-auditor.md"), "utf8");

    expect(created.name).toBe("security-boundary-auditor");
    expect(created.source).toBe("project");
    expect(created.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(definition).toContain("Act as this project's Security Boundary Auditor.");
    expect((await createProjectDelegateAgent(dir, "security-boundary-auditor")).filePath).toBe(created.filePath);
  });

  it("creates agents at the repository root when delegation starts in a subdirectory", async () => {
    const dir = await temp();
    const nested = join(dir, "packages", "api");
    await mkdir(join(dir, ".git"));
    await mkdir(nested, { recursive: true });

    const created = await createProjectDelegateAgent(nested, "API Contract Auditor");
    expect(created.filePath).toBe(join(dir, ".parallax", "agents", "api-contract-auditor.md"));
    expect((await discoverDelegateAgents(nested, "project", true)).map((agent) => agent.name)).toContain("api-contract-auditor");
  });

  it("publishes one complete definition when the same role is created concurrently", async () => {
    const dir = await temp();
    const created = await Promise.all(Array.from({ length: 8 }, () => createProjectDelegateAgent(dir, "Race Auditor")));
    expect(new Set(created.map((agent) => agent.filePath)).size).toBe(1);
    expect(await readFile(created[0]!.filePath, "utf8")).toContain("name: race-auditor");
  });

  it("rejects project agent names and symlinks that could escape the agents directory", async () => {
    const dir = await temp();
    await expect(createProjectDelegateAgent(dir, "../reviewer")).rejects.toThrow("Delegate agent names");

    const outside = await temp();
    await symlink(outside, join(dir, ".parallax"), process.platform === "win32" ? "junction" : "dir");
    await expect(createProjectDelegateAgent(dir, "reviewer-two")).rejects.toThrow("trusted project directory");
  });

  it("ignores malformed optional definitions", async () => {
    const dir = await temp();
    const agentsDir = join(dir, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "bad.md"), "No frontmatter");
    expect(await discoverDelegateAgents(dir, "project", true)).toEqual([]);
  });
});
