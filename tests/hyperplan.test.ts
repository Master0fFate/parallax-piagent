import { describe, expect, it } from "vitest";
import {
  assessComplexity,
  generateAnalysis,
  generateCrossAttacks,
  selectAngles,
  synthesizeCritiques,
  type HyperplanCritique,
} from "../src/hyperplan.js";

const critique = (overrides: Partial<HyperplanCritique> = {}): HyperplanCritique => ({
  angleId: "sentinel",
  angleName: "Sentinel",
  severity: "critical",
  findings: "Missing rollback for schema migration",
  affectedAreas: ["database"],
  ...overrides,
});

describe("adaptive hyperplan", () => {
  it("skips trivial plans", () => {
    const result = generateAnalysis("Rename one label.");
    expect(result.assessment.level).toBe("trivial");
    expect(result.prompts).toEqual([]);
  });

  it("uses critical angles for moderate plans", () => {
    const assessment = assessComplexity("Add an API integration.");
    expect(selectAngles(assessment).map((angle) => angle.id)).toEqual(["integration", "sentinel"]);
  });

  it("uses all angles for complex plans", () => {
    const plan = "Migrate auth API and database schema with async workers, deployment rollback, retries, and monitoring.";
    expect(generateAnalysis(plan).prompts).toHaveLength(5);
  });

  it("forces critical review for trivial plans", () => {
    expect(generateAnalysis("Rename a label", { force: true }).prompts).toHaveLength(2);
  });

  it("includes project context without inventing it", () => {
    const result = generateAnalysis("Add an API integration", { context: "Uses Fastify", force: true });
    expect(result.prompts[0]?.prompt).toContain("Uses Fastify");
  });

  it("cross-attacks omit the critic's own finding", () => {
    const findings = [critique(), critique({ angleId: "integration", angleName: "Integration Tester", findings: "Contract mismatch" })];
    const sentinel = generateCrossAttacks("Add an API integration", findings).find((item) => item.angleId === "sentinel");
    expect(sentinel?.prompt).not.toContain("Missing rollback");
    expect(sentinel?.prompt).toContain("Contract mismatch");
  });
});

describe("synthesis", () => {
  it("de-duplicates normalized findings", () => {
    const result = synthesizeCritiques([
      critique(),
      critique({ angleId: "integration", angleName: "Integration", severity: "major", findings: "missing rollback for schema migration!" }),
    ]);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.hardConstraints).toHaveLength(1);
  });

  it("keeps the highest severity duplicate", () => {
    const result = synthesizeCritiques([
      critique({ severity: "minor" }),
      critique({ severity: "critical", angleName: "Integration" }),
    ]);
    expect(result.hardConstraints[0]).toContain("Integration");
  });

  it("produces all material output categories", () => {
    const result = synthesizeCritiques([
      critique(),
      critique({ severity: "major", findings: "State owner unclear" }),
      critique({ severity: "minor", findings: "Naming remains open" }),
    ]);
    expect(result.markdown).toContain("Hard Constraints");
    expect(result.markdown).toContain("Decisions");
    expect(result.markdown).toContain("Risks");
    expect(result.markdown).toContain("Open Questions");
  });
});
