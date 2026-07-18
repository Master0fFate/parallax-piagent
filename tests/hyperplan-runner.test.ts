import { describe, expect, it } from "vitest";
import type { DelegateResult, DelegateTask } from "../src/delegate.js";
import { extractJson, runHyperplan } from "../src/hyperplan-runner.js";

function result(task: DelegateTask, output: string): DelegateResult {
  return {
    agent: task.agent,
    source: "builtin",
    task: task.task,
    output,
    success: true,
    durationMs: 1,
    toolCalls: [],
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0.01 },
  };
}

describe("Hyperplan runner", () => {
  it("extracts JSON from fenced and surrounding prose", () => {
    expect(extractJson("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
    expect(extractJson("Result: [1,2] done")).toEqual([1, 2]);
  });

  it("skips trivial work without delegate calls", async () => {
    let calls = 0;
    const run = await runHyperplan({ plan: "Rename label", depth: "focused" }, async () => {
      calls += 1;
      return [];
    });
    expect(run.skipped).toBe(true);
    expect(calls).toBe(0);
  });

  it("runs focused critics in parallel and synthesizes", async () => {
    const run = await runHyperplan({ plan: "Add an API integration", depth: "focused" }, async (tasks) =>
      tasks.map((task, index) => result(task, JSON.stringify({
        angleId: index ? "sentinel" : "integration",
        angleName: index ? "Sentinel" : "Integration",
        severity: index ? "major" : "critical",
        findings: index ? "Retry policy missing" : "Contract unspecified",
        affectedAreas: ["api"],
      }))),
    );
    expect(run.rounds).toBe(1);
    expect(run.critiques).toHaveLength(2);
    expect(run.markdown).toContain("Contract unspecified");
    expect(run.cost).toBeCloseTo(0.02);
  });

  it("runs all three debate rounds", async () => {
    let round = 0;
    const run = await runHyperplan({ plan: "Add an API integration", depth: "debate" }, async (tasks) => {
      round += 1;
      if (round === 1) return tasks.map((task, index) => result(task, JSON.stringify({
        angleId: index ? "sentinel" : "integration",
        angleName: index ? "Sentinel" : "Integration",
        severity: "major",
        findings: `finding-${index}`,
        affectedAreas: [],
      })));
      if (round === 2) return tasks.map((task) => result(task, JSON.stringify([{ targetAngleId: "integration", attack: "weak" }])));
      return tasks.map((task) => result(task, JSON.stringify([{ response: "DEFEND", reasoning: "evidence" }])));
    });
    expect(run.rounds).toBe(3);
    expect(round).toBe(3);
    expect(run.critiques.length).toBeGreaterThan(0);
  });
});
