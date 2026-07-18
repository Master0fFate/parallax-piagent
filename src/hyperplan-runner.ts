import type { DelegateResult, DelegateTask } from "./delegate.js";
import {
  generateAnalysis,
  generateCrossAttacks,
  generateDefenses,
  synthesizeCritiques,
  type HyperplanCritique,
} from "./hyperplan.js";

export interface HyperplanRunOptions {
  plan: string;
  context?: string;
  angles?: string[];
  force?: boolean;
  depth: "focused" | "debate";
}

export interface HyperplanRunResult {
  skipped: boolean;
  rounds: number;
  critiques: HyperplanCritique[];
  confidence: number;
  cost: number;
  markdown: string;
}

type ExecuteDelegates = (tasks: DelegateTask[]) => Promise<DelegateResult[]>;

export async function runHyperplan(
  options: HyperplanRunOptions,
  execute: ExecuteDelegates,
): Promise<HyperplanRunResult> {
  const generated = generateAnalysis(options.plan, {
    ...(options.angles ? { requestedAngles: options.angles } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  if (generated.prompts.length === 0) {
    return {
      skipped: true,
      rounds: 0,
      critiques: [],
      confidence: 100,
      cost: 0,
      markdown: `${generated.assessment.reason}\n\nHyperplan skipped because additional adversarial work would not justify its cost.`,
    };
  }

  const analysisResults = await execute(generated.prompts.map((prompt) => ({ agent: "critic", task: prompt.prompt })));
  let cost = totalCost(analysisResults);
  let critiques = analysisResults.map((result, index) => parseCritique(result.output, {
    angleId: generated.prompts[index]?.angleId ?? result.agent,
    angleName: generated.prompts[index]?.angleId ?? result.agent,
    severity: generated.assessment.level === "complex" ? "major" : "critical",
  }));

  if (options.depth === "focused") {
    const synthesis = synthesizeCritiques(critiques);
    return {
      skipped: false,
      rounds: 1,
      critiques,
      confidence: synthesis.confidence,
      cost,
      markdown: `${synthesis.markdown}\n\nRounds: 1 focused analysis. Delegate cost: $${cost.toFixed(4)}.`,
    };
  }

  const crossPrompts = generateCrossAttacks(options.plan, critiques, options.angles);
  const crossResults = await execute(crossPrompts.map((prompt) => ({ agent: "critic", task: prompt.prompt })));
  cost += totalCost(crossResults);
  const attacksByAngle: Record<string, unknown[]> = {};
  for (const result of crossResults) {
    for (const response of parseArray(result.output)) {
      if (!response || typeof response !== "object") continue;
      const target = (response as { targetAngleId?: unknown }).targetAngleId;
      if (typeof target !== "string") continue;
      (attacksByAngle[target] ??= []).push(response);
    }
  }

  const defensePrompts = generateDefenses(options.plan, attacksByAngle, options.angles);
  const defenseResults = await execute(defensePrompts.map((prompt) => ({ agent: "critic", task: prompt.prompt })));
  cost += totalCost(defenseResults);
  const defenses = new Map<string, unknown[]>();
  defenseResults.forEach((result, index) => defenses.set(defensePrompts[index]?.angleId ?? result.agent, parseArray(result.output)));
  critiques = applyDefenses(critiques, defenses);
  const synthesis = synthesizeCritiques(critiques);

  return {
    skipped: false,
    rounds: 3,
    critiques,
    confidence: synthesis.confidence,
    cost,
    markdown: `${synthesis.markdown}\n\nRounds: 3 (analysis, cross-attack, defense). Surviving critiques: ${critiques.length}. Delegate cost: $${cost.toFixed(4)}.`,
  };
}

function applyDefenses(critiques: HyperplanCritique[], defenses: Map<string, unknown[]>): HyperplanCritique[] {
  return critiques.flatMap((critique) => {
    const responses = defenses.get(critique.angleId) ?? [];
    const typed = responses.filter((response): response is Record<string, unknown> => Boolean(response && typeof response === "object"));
    if (typed.length > 0 && typed.every((response) => response.response === "CONCEDE")) return [];
    const refinement = typed.find((response) => response.response === "REFINE" && typeof response.revisedFinding === "string");
    return [{
      ...critique,
      ...(refinement ? { findings: refinement.revisedFinding as string } : {}),
    }];
  });
}

function parseCritique(
  output: string,
  fallback: Pick<HyperplanCritique, "angleId" | "angleName" | "severity">,
): HyperplanCritique {
  const parsed = extractJson(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    return {
      angleId: typeof value.angleId === "string" ? value.angleId : fallback.angleId,
      angleName: typeof value.angleName === "string" ? value.angleName : fallback.angleName,
      severity: value.severity === "critical" || value.severity === "major" || value.severity === "minor"
        ? value.severity
        : fallback.severity,
      findings: typeof value.findings === "string" ? value.findings : output,
      affectedAreas: Array.isArray(value.affectedAreas)
        ? value.affectedAreas.filter((area): area is string => typeof area === "string")
        : [],
    };
  }
  return { ...fallback, findings: output, affectedAreas: [] };
}

function parseArray(output: string): unknown[] {
  const parsed = extractJson(output);
  return Array.isArray(parsed) ? parsed : [];
}

export function extractJson(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, output.trim(), balancedJson(output)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }
  return null;
}

function balancedJson(output: string): string | null {
  const objectStart = output.indexOf("{");
  const arrayStart = output.indexOf("[");
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return null;
  const opener = output[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < output.length; index++) {
    const character = output[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === "\"") quoted = !quoted;
    if (quoted) continue;
    if (character === opener) depth += 1;
    if (character === closer) depth -= 1;
    if (depth === 0) return output.slice(start, index + 1);
  }
  return null;
}

function totalCost(results: DelegateResult[]): number {
  return results.reduce((sum, result) => sum + result.usage.cost, 0);
}
