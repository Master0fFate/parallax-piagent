import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeId, HorizonStore } from "../src/horizon.js";
import type { HorizonPlan } from "../src/types.js";

const dirs: string[] = [];
async function setup(): Promise<{ dir: string; store: HorizonStore }> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-horizon-"));
  dirs.push(dir);
  return { dir, store: new HorizonStore(dir) };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function plan(sessionId: string): HorizonPlan {
  return {
    schemaVersion: "2.0",
    sessionId,
    goal: "Ship the feature",
    autonomy: "full",
    status: "planning",
    createdAt: new Date().toISOString(),
    completedAt: null,
    milestones: [{
      id: "m1",
      name: "Core",
      description: "Core work",
      status: "pending",
      order: 1,
      features: [{
        id: "f1",
        name: "Feature",
        description: "Implement",
        acceptanceCriteria: ["Tests pass"],
        status: "pending",
        order: 1,
        attempts: 0,
        maxAttempts: 2,
        verification: { passed: false, score: null, testResults: null, issues: [] },
      }],
    }],
    sessionSkills: [],
    stats: { totalFeatures: 99, completedFeatures: 99, failedFeatures: 99, totalAttempts: 99 },
  };
}

describe("Horizon storage", () => {
  it("validates and persists runtime configuration", async () => {
    const { store } = await setup();
    const config = await store.saveConfig({ maxRetryCycles: 5, evaluationThreshold: 80, pauseOnCriticalFailure: false });
    expect(config.maxRetryCycles).toBe(5);
    expect(config.evaluationThreshold).toBe(80);
    expect(config.pauseOnCriticalFailure).toBe(false);
    expect(await store.loadConfig()).toEqual(config);
  });

  it("uses configured retry defaults for incomplete feature input", async () => {
    const { store } = await setup();
    await store.saveConfig({ maxRetryCycles: 5 });
    await store.init("s1", "Goal");
    const input = plan("s1");
    delete (input.milestones[0]!.features[0] as { maxAttempts?: number }).maxAttempts;
    const stored = await store.writePlan("s1", input);
    expect(stored.milestones[0]!.features[0]!.maxAttempts).toBe(5);
  });

  it("rejects traversal IDs", () => {
    expect(() => assertSafeId("session", "../escape")).toThrow();
    expect(() => assertSafeId("session", "safe-id")).not.toThrow();
  });

  it("initializes project-local durable state without overwriting sessions", async () => {
    const { dir, store } = await setup();
    await store.init("s1", "Goal", "full");
    const stored = JSON.parse(await readFile(join(dir, ".parallax", "horizon", "sessions", "s1", "plan.json"), "utf8")) as HorizonPlan;
    expect(stored.goal).toBe("Goal");
    expect((await store.listSessions())[0]?.id).toBe("s1");
    await expect(store.init("s1", "Replacement", "full")).rejects.toThrow("already exists");
    expect((await store.readPlan("s1"))?.goal).toBe("Goal");
  });

  it("recomputes untrusted plan stats", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    const stored = await store.writePlan("s1", plan("wrong"));
    expect(stored.sessionId).toBe("s1");
    expect(stored.stats.totalFeatures).toBe(1);
    expect(stored.stats.completedFeatures).toBe(0);
  });

  it("rejects duplicate feature IDs", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    const duplicate = plan("s1");
    duplicate.milestones.push({ ...duplicate.milestones[0]!, id: "m2", features: [{ ...duplicate.milestones[0]!.features[0]! }] });
    await expect(store.writePlan("s1", duplicate)).rejects.toThrow("Feature IDs must be unique");
  });

  it("rejects invalid execution phases", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await expect(store.writeState("s1", { phase: "invalid" as "research" })).rejects.toThrow("Invalid Horizon phase");
  });

  it("increments attempts once per transition", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await store.writePlan("s1", plan("s1"));
    expect((await store.updateFeature("s1", "f1", "in_progress")).milestones[0]?.features[0]?.attempts).toBe(1);
    expect((await store.updateFeature("s1", "f1", "in_progress")).milestones[0]?.features[0]?.attempts).toBe(1);
  });

  it("enforces retry caps", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await store.writePlan("s1", plan("s1"));
    await store.updateFeature("s1", "f1", "in_progress");
    const retryable = await store.updateFeature("s1", "f1", "failed");
    expect(retryable.status).toBe("executing");
    expect(retryable.milestones[0]!.status).toBe("pending");
    await store.updateFeature("s1", "f1", "in_progress");
    const exhausted = await store.updateFeature("s1", "f1", "failed");
    expect(exhausted.status).toBe("failed");
    expect(exhausted.milestones[0]!.status).toBe("failed");
    await expect(store.updateFeature("s1", "f1", "in_progress")).rejects.toThrow("Retry cap");
  });

  it("completes a plan when all features complete", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await store.writePlan("s1", plan("s1"));
    const result = await store.updateFeature("s1", "f1", "completed");
    expect(result.status).toBe("completed");
    expect(result.completedAt).not.toBeNull();
  });

  it("rejects orphaned memory writes before session initialization", async () => {
    const { store } = await setup();
    await expect(store.appendDecision("missing", {
      featureId: null,
      ambiguity: "unknown",
      research: "none",
      decision: "none",
      rationale: "no session",
      confidence: "low",
    })).rejects.toThrow("not found");
    await expect(store.writeResearch("missing", "findings", {})).rejects.toThrow("not found");
  });

  it("logs decisions in order", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    const base = { featureId: null, ambiguity: "a", research: "r", rationale: "why", confidence: "high" as const };
    await store.appendDecision("s1", { ...base, decision: "one" });
    await store.appendDecision("s1", { ...base, decision: "two" });
    expect((await store.readDecisions("s1")).map((item) => item.decision)).toEqual(["one", "two"]);
  });

  it("creates standards-compliant session skills", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    const path = await store.createSkill("s1", "project-patterns", "Use project patterns", "# Patterns\nFollow them.");
    const content = await readFile(path, "utf8");
    expect(content).toContain("name: project-patterns");
    expect(content).toContain("metadata:");
    expect((await store.readPlan("s1"))?.sessionSkills).toEqual(["project-patterns"]);
  });

  it("never passes evaluation when real verification is below threshold", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await store.writePlan("s1", plan("s1"));
    const result = await store.evaluateFeature("s1", "f1", {
      protocol: 100, verification: 0, correctness: 100, design: 100, edgeCases: 100, userPerspective: 100,
    });
    expect(result.score).toBe(75);
    expect(result.passed).toBe(false);
  });

  it("evaluates work with weighted evidence dimensions", async () => {
    const { store } = await setup();
    await store.init("s1", "Goal", "full");
    await store.writePlan("s1", plan("s1"));
    const result = await store.evaluateFeature("s1", "f1", {
      protocol: 80, verification: 100, correctness: 90, design: 80, edgeCases: 70, userPerspective: 80,
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(75);
  });
});
