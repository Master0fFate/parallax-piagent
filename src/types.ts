export type ParallaxMode = "build" | "plan" | "debug" | "horizon";
export type ProtocolStep = "ambiguity" | "invariants" | "gate" | "design" | "commit" | "summary";
export type Strictness = "strict" | "standard" | "relaxed";
export type VerificationVerdict = "pass" | "fail" | "skipped";

export interface ParallaxConfig {
  strictness: Strictness;
  adaptiveProtocol: boolean;
  autoActivateOnMutation: boolean;
  autoVerify: boolean;
  designDocRequired: boolean;
  minScore: number;
  maxRetries: number;
  verificationTimeoutMs: number;
  trivialPatterns: string[];
  highRiskPatterns: string[];
  verifyCommand?: string;
}

export interface ProtocolState {
  completed: Record<ProtocolStep, boolean>;
  evidence: Partial<Record<ProtocolStep, string>>;
}

export interface FrictionState {
  consecutiveFailures: number;
  retriesLeft: number;
  successes: number;
  trials: number;
  lastFailure: string | null;
  lastVerdict: VerificationVerdict | null;
}

export interface TracePhase {
  step: ProtocolStep | "mode" | "analysis";
  timestamp: string;
  detail?: string;
}

export interface VerificationRecord {
  timestamp: string;
  command: string | null;
  files: string[];
  verdict: VerificationVerdict;
  exitCode: number | null;
  durationMs: number;
  output: string;
  fullOutputPath?: string;
}

export interface ParallaxTrace {
  schemaVersion: "2.0";
  sessionId: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  phases: TracePhase[];
  verifications: VerificationRecord[];
}

export interface ParallaxState {
  schemaVersion: "2.0";
  mode: ParallaxMode;
  protocol: ProtocolState;
  friction: FrictionState;
  trace: ParallaxTrace;
  horizonSessionId: string | null;
}

export type HorizonAutonomy = "full" | "semi" | "supervised";
export type HorizonStatus = "pending" | "in_progress" | "completed" | "failed";

export interface HorizonFeature {
  id: string;
  name: string;
  description: string;
  acceptanceCriteria: string[];
  status: HorizonStatus;
  order: number;
  attempts: number;
  maxAttempts: number;
  verification: {
    passed: boolean;
    score: number | null;
    testResults: string | null;
    issues: string[];
  };
}

export interface HorizonMilestone {
  id: string;
  name: string;
  description: string;
  status: HorizonStatus;
  order: number;
  features: HorizonFeature[];
}

export interface HorizonPlan {
  schemaVersion: "2.0";
  sessionId: string;
  goal: string;
  autonomy: HorizonAutonomy;
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  milestones: HorizonMilestone[];
  sessionSkills: string[];
  stats: {
    totalFeatures: number;
    completedFeatures: number;
    failedFeatures: number;
    totalAttempts: number;
  };
}

export interface HorizonExecutionState {
  sessionId: string;
  phase: "research" | "plan" | "execute" | "audit" | "complete";
  activeMilestoneId: string | null;
  activeFeatureId: string | null;
  lastCheckpoint: string;
  paused: boolean;
  pauseReason: string | null;
}

export interface HorizonRuntimeConfig {
  defaultAutonomy: HorizonAutonomy;
  maxRetryCycles: number;
  evaluationThreshold: number;
  pauseOnCriticalFailure: boolean;
}

export interface HorizonDecision {
  timestamp: string;
  featureId: string | null;
  ambiguity: string;
  research: string;
  decision: string;
  rationale: string;
  confidence: "high" | "medium" | "low";
}
