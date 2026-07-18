import { computeTraceScore } from "./trace-analytics.mjs";
import type {
  ParallaxConfig,
  ParallaxMode,
  ParallaxState,
  ProtocolStep,
  Strictness,
  VerificationRecord,
} from "./types.js";

export const PROTOCOL_STEPS: ProtocolStep[] = [
  "ambiguity",
  "invariants",
  "gate",
  "design",
  "commit",
  "summary",
];

const PREREQUISITE: Partial<Record<ProtocolStep, ProtocolStep>> = {
  invariants: "ambiguity",
  gate: "invariants",
  design: "gate",
  commit: "gate",
  summary: "commit",
};

export const DEFAULT_CONFIG: ParallaxConfig = {
  strictness: "standard",
  adaptiveProtocol: true,
  autoVerify: true,
  designDocRequired: false,
  minScore: 70,
  maxRetries: 3,
  verificationTimeoutMs: 120_000,
  trivialPatterns: ["*.md", "*.txt"],
  highRiskPatterns: ["**/auth/**", "**/*.env*", "**/migrations/**"],
};

export interface PersistedParallaxSnapshot {
  snapshotVersion: "1";
  state: Omit<ParallaxState, "trace">;
  trace: Omit<ParallaxState["trace"], "phases" | "verifications">;
  phases: ParallaxState["trace"]["phases"];
  verifications: ParallaxState["trace"]["verifications"];
}

export function createState(sessionId: string, cwd: string, maxRetries = 3): ParallaxState {
  const completed = Object.fromEntries(PROTOCOL_STEPS.map((step) => [step, false])) as Record<ProtocolStep, boolean>;
  return {
    schemaVersion: "2.0",
    mode: "build",
    protocol: { completed, evidence: {} },
    friction: {
      consecutiveFailures: 0,
      retriesLeft: maxRetries,
      successes: 0,
      trials: 0,
      lastFailure: null,
      lastVerdict: null,
    },
    trace: {
      schemaVersion: "2.0",
      sessionId,
      cwd,
      startedAt: new Date().toISOString(),
      endedAt: null,
      phases: [],
      verifications: [],
    },
    horizonSessionId: null,
  };
}

export function requiredWriteSteps(strictness: Strictness, designDocRequired: boolean): ProtocolStep[] {
  if (designDocRequired) return ["ambiguity", "invariants", "gate", "design"];
  return strictness === "relaxed"
    ? ["ambiguity"]
    : strictness === "standard"
      ? ["ambiguity", "invariants"]
      : ["ambiguity", "invariants", "gate"];
}

export function effectiveStrictness(path: string | undefined, config: ParallaxConfig): Strictness {
  if (!path || !config.adaptiveProtocol) return config.strictness;
  if (config.highRiskPatterns.some((pattern) => matchesGlob(path, pattern))) return "strict";
  if (config.trivialPatterns.some((pattern) => matchesGlob(path, pattern))) return "relaxed";
  return config.strictness;
}

export function missingWriteSteps(state: ParallaxState, config: ParallaxConfig, path?: string): ProtocolStep[] {
  return requiredWriteSteps(effectiveStrictness(path, config), config.designDocRequired)
    .filter((step) => !state.protocol.completed[step]);
}

export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  let normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedPattern.includes("/")) normalizedPattern = `**/${normalizedPattern}`;
  const marker = "\u0000";
  const source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, marker)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(marker, "g"), ".*")
    .replace(/\?/g, "[^/]");
  const direct = new RegExp(`^${source}$`);
  return direct.test(normalizedPath) || (normalizedPattern.startsWith("**/") && new RegExp(`^${source.slice(3)}$`).test(normalizedPath));
}

export function checkIn(
  state: ParallaxState,
  step: ProtocolStep,
  evidence?: string,
): { changed: boolean; message: string } {
  if (state.protocol.completed[step]) {
    return { changed: false, message: `${step} was already complete.` };
  }

  const prerequisite = PREREQUISITE[step];
  if (prerequisite && !state.protocol.completed[prerequisite]) {
    return { changed: false, message: `Complete ${prerequisite} before ${step}.` };
  }

  const detail = evidence?.trim();
  if (!detail || detail.length < 8) {
    return { changed: false, message: `${step} requires concrete evidence (at least 8 characters).` };
  }

  state.protocol.completed[step] = true;
  state.protocol.evidence[step] = detail;
  state.trace.phases.push({ step, timestamp: new Date().toISOString(), detail });
  return { changed: true, message: `${step} marked complete.` };
}

export function setMode(state: ParallaxState, mode: ParallaxMode): void {
  if (state.mode === mode) return;
  state.mode = mode;
  state.trace.phases.push({ step: "mode", detail: mode, timestamp: new Date().toISOString() });
}

export function recordAnalysis(state: ParallaxState, topic: string): void {
  state.trace.phases.push({ step: "analysis", detail: topic, timestamp: new Date().toISOString() });
}

export function recordVerification(
  state: ParallaxState,
  record: VerificationRecord,
  maxRetries: number,
): void {
  state.trace.verifications.push(record);
  state.friction.lastVerdict = record.verdict;
  if (record.verdict === "skipped") return;

  state.friction.trials += 1;
  if (record.verdict === "pass") {
    state.friction.successes += 1;
    state.friction.consecutiveFailures = 0;
    state.friction.retriesLeft = maxRetries;
    state.friction.lastFailure = null;
    return;
  }

  state.friction.consecutiveFailures += 1;
  state.friction.retriesLeft = Math.max(0, maxRetries - state.friction.consecutiveFailures);
  state.friction.lastFailure = record.output.slice(-2_000);
}

export function createSnapshot(
  state: ParallaxState,
  phaseOffset: number,
  verificationOffset: number,
): PersistedParallaxSnapshot {
  const { trace, ...persistentState } = state;
  const { phases, verifications, ...traceMetadata } = trace;
  return {
    snapshotVersion: "1",
    state: structuredClone(persistentState),
    trace: structuredClone(traceMetadata),
    phases: structuredClone(phases.slice(phaseOffset)),
    verifications: structuredClone(verifications.slice(verificationOffset)),
  };
}

export function restoreSnapshots(
  snapshots: PersistedParallaxSnapshot[],
  sessionId: string,
  cwd: string,
  maxRetries: number,
): ParallaxState {
  const latest = snapshots.at(-1);
  if (!latest) return createState(sessionId, cwd, maxRetries);
  return {
    ...structuredClone(latest.state),
    trace: {
      ...structuredClone(latest.trace),
      sessionId,
      cwd,
      phases: snapshots.flatMap((snapshot) => structuredClone(snapshot.phases)),
      verifications: snapshots.flatMap((snapshot) => structuredClone(snapshot.verifications)),
    },
  };
}

export function isPersistedSnapshot(value: unknown): value is PersistedParallaxSnapshot {
  return Boolean(value && typeof value === "object" && (value as { snapshotVersion?: unknown }).snapshotVersion === "1");
}

export function resetProtocol(state: ParallaxState, maxRetries: number): void {
  for (const step of PROTOCOL_STEPS) state.protocol.completed[step] = false;
  state.protocol.evidence = {};
  state.friction = {
    consecutiveFailures: 0,
    retriesLeft: maxRetries,
    successes: 0,
    trials: 0,
    lastFailure: null,
    lastVerdict: null,
  };
}

export function protocolProgress(state: ParallaxState): { completed: number; total: number; next: ProtocolStep | null } {
  const completed = PROTOCOL_STEPS.filter((step) => state.protocol.completed[step]).length;
  return {
    completed,
    total: PROTOCOL_STEPS.length,
    next: PROTOCOL_STEPS.find((step) => !state.protocol.completed[step]) ?? null,
  };
}

export function computeCoherenceScore(state: ParallaxState): number {
  return computeTraceScore(state.trace);
}
