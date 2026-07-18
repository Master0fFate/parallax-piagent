export type HyperplanSeverity = "critical" | "major" | "minor";
export type HyperplanRound = "analysis" | "cross-attack" | "defense";

export interface HyperplanAngle {
  id: string;
  name: string;
  severity: HyperplanSeverity;
  focus: string;
}

export interface HyperplanCritique {
  angleId: string;
  angleName: string;
  severity: HyperplanSeverity;
  findings: string;
  affectedAreas: string[];
}

export interface ComplexityAssessment {
  level: "trivial" | "moderate" | "complex";
  score: number;
  signals: string[];
  reason: string;
}

export const ANGLES: HyperplanAngle[] = [
  { id: "pragmatist", name: "Pragmatist", severity: "major", focus: "Delete scope, ceremony, dependencies, and abstractions that do not pay rent. Test feasibility and time-to-value." },
  { id: "integration", name: "Integration Tester", severity: "critical", focus: "Trace interfaces, state ownership, data flow, compatibility, and failure propagation across boundaries." },
  { id: "sentinel", name: "Sentinel", severity: "critical", focus: "Find security, malformed input, concurrency, recovery, rollback, and operational failure paths." },
  { id: "architect", name: "Architectural Strategist", severity: "major", focus: "Challenge boundaries, coupling, dependencies, extensibility, migration shape, and maintainability." },
  { id: "humanist", name: "Humanist", severity: "major", focus: "Challenge user and maintainer cognitive load, discoverability, error recovery, and workflow friction." },
];

const SIGNALS: Array<[RegExp, string, number]> = [
  [/\b(api|database|migration|integration|architecture|protocol|middleware)\b/i, "system boundary", 2],
  [/\b(async|concurrent|parallel|race|queue|worker|stream)\b/i, "concurrency", 2],
  [/\b(auth|oauth|permission|secret|token|security|encrypt)\b/i, "security", 3],
  [/\b(transaction|replication|schema|cache|index|data flow)\b/i, "data", 2],
  [/\b(deploy|container|kubernetes|rollback|monitor|production)\b/i, "operations", 2],
  [/\b(milestone|phase|multiple|cross-cut|dependency|legacy|refactor)\b/i, "coordination", 1],
  [/\b(retry|timeout|fallback|rate limit|backpressure|edge case)\b/i, "resilience", 2],
];

export function assessComplexity(plan: string): ComplexityAssessment {
  const matched = SIGNALS.filter(([pattern]) => pattern.test(plan));
  const signals = matched.map(([, label]) => label);
  const structure = (/^\s*(?:[-*]\s+\[[ x]\]|\d+[.)]\s+)/m.test(plan) ? 1 : 0) + (plan.split("\n").length > 20 ? 1 : 0);
  const score = matched.reduce((sum, [, , weight]) => sum + weight, 0) + structure;
  const level = score < 2 ? "trivial" : score <= 8 ? "moderate" : "complex";
  return {
    level,
    score,
    signals,
    reason: `${level} plan: score ${score}; ${signals.length ? `signals: ${signals.join(", ")}` : "no material complexity signals"}.`,
  };
}

export function selectAngles(assessment: ComplexityAssessment, requested?: string[], force = false): HyperplanAngle[] {
  if (requested?.length) {
    const selected = ANGLES.filter((angle) => requested.includes(angle.id));
    if (selected.length) return selected;
  }
  if (assessment.level === "trivial") return force ? ANGLES.filter((angle) => angle.severity === "critical") : [];
  if (assessment.level === "moderate") return ANGLES.filter((angle) => angle.severity === "critical");
  return ANGLES;
}

export function generateAnalysis(
  plan: string,
  options: { requestedAngles?: string[]; force?: boolean; context?: string } = {},
): { assessment: ComplexityAssessment; prompts: Array<{ angleId: string; prompt: string }> } {
  const assessment = assessComplexity(plan);
  const angles = selectAngles(assessment, options.requestedAngles, options.force);
  return {
    assessment,
    prompts: angles.map((angle) => ({
      angleId: angle.id,
      prompt: [
        `ROLE: ${angle.name}`,
        `FOCUS: ${angle.focus}`,
        "",
        "PLAN:",
        plan,
        ...(options.context ? ["", "PROJECT CONTEXT:", options.context] : []),
        "",
        "Return one JSON object:",
        `{\"angleId\":\"${angle.id}\",\"angleName\":\"${angle.name}\",\"severity\":\"critical|major|minor\",\"findings\":\"specific evidence and remediation\",\"affectedAreas\":[\"area\"],\"selfCritique\":\"weakest part of this critique\"}`,
        "Material findings only. Name concrete contracts, files, or failure paths when evidence permits. Do not invent defects to fill space.",
      ].join("\n"),
    })),
  };
}

export function generateCrossAttacks(
  plan: string,
  findings: HyperplanCritique[],
  requestedAngles?: string[],
): Array<{ angleId: string; prompt: string }> {
  const angles = selectAngles(assessComplexity(plan), requestedAngles, true);
  return angles.map((angle) => {
    const others = findings.filter((finding) => finding.angleId !== angle.id);
    return {
      angleId: angle.id,
      prompt: [
        `ROLE: ${angle.name}. Test other critics through this focus: ${angle.focus}`,
        "For each material finding below, return DEFEND (it stands), REFINE (a narrower stronger claim), or CONCEDE (unsupported).",
        JSON.stringify(others),
        "Output a JSON array of {targetAngleId,response,reasoning,revisedFinding?}. Do not repeat findings without adding evidence.",
      ].join("\n\n"),
    };
  });
}

export function generateDefenses(
  plan: string,
  attacks: Record<string, unknown[]>,
  requestedAngles?: string[],
): Array<{ angleId: string; prompt: string }> {
  const angles = selectAngles(assessComplexity(plan), requestedAngles, true);
  return angles
    .filter((angle) => (attacks[angle.id]?.length ?? 0) > 0)
    .map((angle) => ({
      angleId: angle.id,
      prompt: [
        `ROLE: ${angle.name}. Your findings were challenged.`,
        JSON.stringify(attacks[angle.id]),
        "For each attack return a JSON object with response DEFEND, REFINE, or CONCEDE; concrete reasoning; and revisedFinding when applicable. Concede unsupported claims.",
      ].join("\n\n"),
    }));
}

export function synthesizeCritiques(critiques: HyperplanCritique[]): {
  confidence: number;
  hardConstraints: string[];
  decisions: string[];
  risks: Array<{ risk: string; mitigation: string }>;
  openQuestions: string[];
  duplicatesRemoved: number;
  markdown: string;
} {
  const valid = critiques.filter(isCritique);
  const unique = new Map<string, HyperplanCritique>();
  for (const critique of valid) {
    const key = normalizeFinding(critique.findings);
    const existing = unique.get(key);
    if (!existing || severityWeight(critique.severity) > severityWeight(existing.severity)) unique.set(key, critique);
  }
  const findings = [...unique.values()];
  const hardConstraints = findings.filter((item) => item.severity === "critical").map(formatFinding);
  const decisions = findings.filter((item) => item.severity === "major").map(formatFinding);
  const openQuestions = findings.filter((item) => item.severity === "minor").map(formatFinding);
  const risks = findings
    .filter((item) => item.severity !== "minor")
    .map((item) => ({ risk: formatFinding(item), mitigation: "Resolve with an explicit plan change and acceptance check before execution." }));
  const penalty = findings.reduce((sum, finding) => sum + ({ critical: 15, major: 8, minor: 3 })[finding.severity], 0);
  const confidence = Math.max(0, 100 - penalty);
  const duplicatesRemoved = valid.length - findings.length;
  const section = (title: string, items: string[], fallback: string) => `### ${title}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : fallback}`;
  const markdown = [
    "## Hyperplan Insight Bundle",
    `Confidence: ${confidence}/100`,
    duplicatesRemoved ? `De-duplicated findings: ${duplicatesRemoved}` : "",
    section("Hard Constraints", hardConstraints, "No critical constraints surfaced."),
    section("Decisions", decisions, "No major decisions surfaced."),
    section("Risks", risks.map((item) => `${item.risk} Mitigation: ${item.mitigation}`), "No material risks surfaced."),
    section("Open Questions", openQuestions, "No open questions surfaced."),
  ].filter(Boolean).join("\n\n");
  return { confidence, hardConstraints, decisions, risks, openQuestions, duplicatesRemoved, markdown };
}

function isCritique(value: HyperplanCritique): boolean {
  return Boolean(
    value && typeof value.angleId === "string" && typeof value.angleName === "string" &&
    ["critical", "major", "minor"].includes(value.severity) && typeof value.findings === "string" &&
    Array.isArray(value.affectedAreas),
  );
}

function normalizeFinding(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function severityWeight(severity: HyperplanSeverity): number {
  return { critical: 3, major: 2, minor: 1 }[severity];
}

function formatFinding(critique: HyperplanCritique): string {
  const areas = critique.affectedAreas.length ? ` [${critique.affectedAreas.join(", ")}]` : "";
  return `${critique.angleName}: ${critique.findings}${areas}`;
}
