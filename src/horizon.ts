import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  HorizonAutonomy,
  HorizonDecision,
  HorizonExecutionState,
  HorizonFeature,
  HorizonMilestone,
  HorizonPlan,
  HorizonRuntimeConfig,
  HorizonStatus,
} from "./types.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ITEM_STATUSES = new Set<HorizonStatus>(["pending", "in_progress", "completed", "failed"]);
const PLAN_STATUSES = new Set<HorizonPlan["status"]>(["planning", "executing", "completed", "failed"]);
const HORIZON_PHASES = new Set<HorizonExecutionState["phase"]>(["research", "plan", "execute", "audit", "complete"]);
const DEFAULT_HORIZON_CONFIG: HorizonRuntimeConfig = {
  defaultAutonomy: "full",
  maxRetryCycles: 3,
  evaluationThreshold: 75,
  pauseOnCriticalFailure: true,
};

function now(): string {
  return new Date().toISOString();
}

export function assertSafeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || basename(value) !== value) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
  return value;
}

export class HorizonStore {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cwd: string) {
    this.root = join(cwd, ".parallax", "horizon");
  }

  private sessionDir(sessionId: string): string {
    const root = resolve(this.root, "sessions");
    const path = resolve(root, assertSafeId("session ID", sessionId));
    if (path !== root && !path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) {
      throw new Error(`Session path escapes Horizon root: ${path}`);
    }
    return path;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async loadConfig(): Promise<HorizonRuntimeConfig> {
    const value = await this.readJson<Partial<HorizonRuntimeConfig>>(join(this.root, "config.json"));
    return normalizeHorizonConfig(value ?? {});
  }

  async saveConfig(patch: Partial<HorizonRuntimeConfig>): Promise<HorizonRuntimeConfig> {
    return this.serial(async () => {
      const config = normalizeHorizonConfig({ ...(await this.loadConfig()), ...patch });
      await mkdir(this.root, { recursive: true });
      await this.atomicJson(join(this.root, "config.json"), config);
      return config;
    });
  }

  async init(sessionId: string, goal: string, autonomy?: HorizonAutonomy): Promise<HorizonPlan> {
    return this.serial(async () => {
      if (await this.readPlan(sessionId)) throw new Error(`Horizon session already exists: ${sessionId}`);
      const dir = this.sessionDir(sessionId);
      await Promise.all([
        mkdir(join(dir, "research"), { recursive: true }),
        mkdir(join(dir, "skills"), { recursive: true }),
        mkdir(join(dir, "traces"), { recursive: true }),
      ]);
      const runtimeConfig = await this.loadConfig();
      const plan: HorizonPlan = normalizePlan({
        schemaVersion: "2.0",
        sessionId,
        goal,
        autonomy: autonomy ?? runtimeConfig.defaultAutonomy,
        status: "planning",
        createdAt: now(),
        completedAt: null,
        milestones: [],
        sessionSkills: [],
        stats: { totalFeatures: 0, completedFeatures: 0, failedFeatures: 0, totalAttempts: 0 },
      }, sessionId, runtimeConfig.maxRetryCycles);
      const state: HorizonExecutionState = {
        sessionId,
        phase: "research",
        activeMilestoneId: null,
        activeFeatureId: null,
        lastCheckpoint: now(),
        paused: false,
        pauseReason: null,
      };
      await Promise.all([
        this.atomicJson(join(dir, "plan.json"), plan),
        this.atomicJson(join(dir, "state.json"), state),
        writeFile(join(dir, "decisions.jsonl"), "", { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        }),
      ]);
      await this.updateIndex(sessionId, plan);
      return plan;
    });
  }

  async readPlan(sessionId: string): Promise<HorizonPlan | null> {
    return this.readJson<HorizonPlan>(join(this.sessionDir(sessionId), "plan.json"));
  }

  async writePlan(sessionId: string, input: unknown): Promise<HorizonPlan> {
    return this.serial(async () => {
      const runtimeConfig = await this.loadConfig();
      const plan = normalizePlan(input, sessionId, runtimeConfig.maxRetryCycles);
      await mkdir(this.sessionDir(sessionId), { recursive: true });
      await this.atomicJson(join(this.sessionDir(sessionId), "plan.json"), plan);
      await this.updateIndex(sessionId, plan);
      return plan;
    });
  }

  async updateFeature(sessionId: string, featureId: string, status: HorizonStatus): Promise<HorizonPlan> {
    if (!ITEM_STATUSES.has(status)) throw new Error(`Invalid feature status: ${status}`);
    return this.serial(async () => {
      const plan = await this.requiredPlan(sessionId);
      const feature = plan.milestones.flatMap((milestone) => milestone.features).find((item) => item.id === featureId);
      if (!feature) throw new Error(`Feature not found: ${featureId}`);
      if (status === "in_progress" && feature.status !== "in_progress") {
        if (feature.attempts >= feature.maxAttempts) throw new Error(`Retry cap reached for ${featureId}`);
        feature.attempts += 1;
      }
      feature.status = status;
      recomputeStats(plan);
      if (plan.stats.totalFeatures > 0 && plan.stats.completedFeatures === plan.stats.totalFeatures) {
        plan.status = "completed";
        plan.completedAt = now();
      } else if (plan.stats.totalFeatures > 0 && plan.milestones
        .flatMap((milestone) => milestone.features)
        .every((item) => item.status === "completed" || (item.status === "failed" && item.attempts >= item.maxAttempts))) {
        plan.status = "failed";
        plan.completedAt = now();
      } else if (status === "in_progress") {
        plan.status = "executing";
      }
      await this.atomicJson(join(this.sessionDir(sessionId), "plan.json"), plan);
      await this.updateIndex(sessionId, plan);
      return plan;
    });
  }

  async updateMilestone(sessionId: string, milestoneId: string, status: HorizonStatus): Promise<HorizonPlan> {
    if (!ITEM_STATUSES.has(status)) throw new Error(`Invalid milestone status: ${status}`);
    return this.serial(async () => {
      const plan = await this.requiredPlan(sessionId);
      const milestone = plan.milestones.find((item) => item.id === milestoneId);
      if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);
      milestone.status = status;
      await this.atomicJson(join(this.sessionDir(sessionId), "plan.json"), plan);
      return plan;
    });
  }

  async evaluateFeature(
    sessionId: string,
    featureId: string,
    scores: Record<"protocol" | "verification" | "correctness" | "design" | "edgeCases" | "userPerspective", number>,
    evidence?: { testResults?: string; issues?: string[] },
  ): Promise<{ score: number; passed: boolean; plan: HorizonPlan }> {
    const entries = Object.values(scores);
    if (entries.some((score) => !Number.isFinite(score) || score < 0 || score > 100)) {
      throw new Error("Evaluation scores must be between 0 and 100.");
    }
    return this.serial(async () => {
      const score = Math.round(
        scores.protocol * 0.15 + scores.verification * 0.25 + scores.correctness * 0.25 +
        scores.design * 0.15 + scores.edgeCases * 0.1 + scores.userPerspective * 0.1,
      );
      const threshold = (await this.loadConfig()).evaluationThreshold;
      const passed = score >= threshold && scores.verification >= threshold;
      const plan = await this.requiredPlan(sessionId);
      const feature = plan.milestones.flatMap((milestone) => milestone.features).find((item) => item.id === featureId);
      if (!feature) throw new Error(`Feature not found: ${featureId}`);
      feature.verification = {
        passed,
        score,
        testResults: evidence?.testResults ?? null,
        issues: evidence?.issues ?? (passed ? [] : [`Weighted evaluation ${score}/100 or verification evidence is below threshold.`]),
      };
      await this.atomicJson(join(this.sessionDir(sessionId), "plan.json"), plan);
      return { score, passed, plan };
    });
  }

  async readState(sessionId: string): Promise<HorizonExecutionState | null> {
    return this.readJson(join(this.sessionDir(sessionId), "state.json"));
  }

  async writeState(sessionId: string, patch: Partial<HorizonExecutionState>): Promise<HorizonExecutionState> {
    return this.serial(async () => {
      const existing = await this.readState(sessionId) ?? {
        sessionId,
        phase: "research" as const,
        activeMilestoneId: null,
        activeFeatureId: null,
        lastCheckpoint: now(),
        paused: false,
        pauseReason: null,
      };
      if (patch.phase !== undefined && !HORIZON_PHASES.has(patch.phase)) throw new Error(`Invalid Horizon phase: ${patch.phase}`);
      const next: HorizonExecutionState = {
        ...existing,
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.activeMilestoneId !== undefined ? { activeMilestoneId: patch.activeMilestoneId } : {}),
        ...(patch.activeFeatureId !== undefined ? { activeFeatureId: patch.activeFeatureId } : {}),
        ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
        ...(patch.pauseReason !== undefined ? { pauseReason: patch.pauseReason } : {}),
        sessionId,
        lastCheckpoint: now(),
      };
      await this.atomicJson(join(this.sessionDir(sessionId), "state.json"), next);
      return next;
    });
  }

  async appendDecision(sessionId: string, decision: Omit<HorizonDecision, "timestamp">): Promise<void> {
    await this.serial(async () => {
      await this.requiredPlan(sessionId);
      const dir = this.sessionDir(sessionId);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "decisions.jsonl"), `${JSON.stringify({ timestamp: now(), ...decision })}\n`, "utf8");
    });
  }

  async readDecisions(sessionId: string): Promise<HorizonDecision[]> {
    try {
      return (await readFile(join(this.sessionDir(sessionId), "decisions.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HorizonDecision);
    } catch {
      return [];
    }
  }

  async writeResearch(sessionId: string, findings: string, sources: Record<string, string>): Promise<void> {
    await this.serial(async () => {
      await this.requiredPlan(sessionId);
      const dir = join(this.sessionDir(sessionId), "research");
      await mkdir(dir, { recursive: true });
      await Promise.all([
        this.atomicText(join(dir, "findings.md"), findings),
        this.atomicJson(join(dir, "sources.json"), sources),
      ]);
    });
  }

  async readResearch(sessionId: string): Promise<{ findings: string; sources: Record<string, string> }> {
    const dir = join(this.sessionDir(sessionId), "research");
    const [findings, sources] = await Promise.all([
      readFile(join(dir, "findings.md"), "utf8").catch(() => ""),
      this.readJson<Record<string, string>>(join(dir, "sources.json")),
    ]);
    return { findings, sources: sources ?? {} };
  }

  async createSkill(sessionId: string, name: string, description: string, content: string): Promise<string> {
    assertSafeId("skill name", name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Skill name must be lowercase kebab-case.");
    const path = join(this.sessionDir(sessionId), "skills", name, "SKILL.md");
    const escapedDescription = JSON.stringify(description.slice(0, 1024));
    await this.serial(async () => {
      const plan = await this.requiredPlan(sessionId);
      await mkdir(join(this.sessionDir(sessionId), "skills", name), { recursive: true });
      await this.atomicText(path, `---\nname: ${name}\ndescription: ${escapedDescription}\nmetadata:\n  parallax-session: ${sessionId}\n---\n\n${content.trim()}\n`);
      if (!plan.sessionSkills.includes(name)) {
        plan.sessionSkills.push(name);
        await this.atomicJson(join(this.sessionDir(sessionId), "plan.json"), plan);
      }
    });
    return path;
  }

  async readSessionSkills(sessionId: string): Promise<Array<{ name: string; content: string }>> {
    const dir = join(this.sessionDir(sessionId), "skills");
    try {
      const names = await readdir(dir);
      const skills = await Promise.all(names.map(async (name) => ({
        name,
        content: await readFile(join(dir, name, "SKILL.md"), "utf8").catch(() => ""),
      })));
      return skills.filter((skill) => skill.content);
    } catch {
      return [];
    }
  }

  async saveTrace(sessionId: string, traceId: string, trace: unknown): Promise<string> {
    assertSafeId("trace ID", traceId);
    const path = join(this.sessionDir(sessionId), "traces", `${traceId}.json`);
    await this.serial(async () => {
      await this.requiredPlan(sessionId);
      await mkdir(join(this.sessionDir(sessionId), "traces"), { recursive: true });
      await this.atomicJson(path, trace);
    });
    return path;
  }

  async listSessions(): Promise<Array<{ id: string; goal: string; status: string; updatedAt: string }>> {
    const index = await this.readJson<Record<string, { goal: string; status: string; updatedAt: string }>>(join(this.root, "index.json"));
    return Object.entries(index ?? {}).map(([id, value]) => ({ id, ...value }));
  }

  async status(sessionId: string): Promise<Record<string, unknown>> {
    const [plan, state, decisions, research, skills] = await Promise.all([
      this.readPlan(sessionId),
      this.readState(sessionId),
      this.readDecisions(sessionId),
      this.readResearch(sessionId),
      this.readSessionSkills(sessionId),
    ]);
    return {
      plan,
      state,
      decisions: decisions.length,
      researchCharacters: research.findings.length,
      skills: skills.map((skill) => skill.name),
    };
  }

  private async requiredPlan(sessionId: string): Promise<HorizonPlan> {
    const plan = await this.readPlan(sessionId);
    if (!plan) throw new Error(`Horizon session not found: ${sessionId}`);
    return plan;
  }

  private async updateIndex(sessionId: string, plan: HorizonPlan): Promise<void> {
    const path = join(this.root, "index.json");
    await mkdir(this.root, { recursive: true });
    const index = await this.readJson<Record<string, { goal: string; status: string; updatedAt: string }>>(path) ?? {};
    index[sessionId] = { goal: plan.goal, status: plan.status, updatedAt: now() };
    await this.atomicJson(path, index);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    await this.atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async atomicText(path: string, value: string): Promise<void> {
    await mkdir(resolve(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, value, "utf8");
    await rename(temporary, path);
  }
}

export function normalizePlan(input: unknown, sessionId: string, defaultMaxAttempts = 3): HorizonPlan {
  if (!input || typeof input !== "object") throw new Error("Plan must be an object.");
  const raw = input as Partial<HorizonPlan>;
  if (typeof raw.goal !== "string" || !raw.goal.trim()) throw new Error("Plan goal is required.");
  if (!Array.isArray(raw.milestones)) throw new Error("Plan milestones must be an array.");
  const autonomy: HorizonAutonomy = ["full", "semi", "supervised"].includes(raw.autonomy ?? "")
    ? raw.autonomy as HorizonAutonomy
    : "full";
  const milestones = raw.milestones.map((milestone, index) => normalizeMilestone(milestone, index, defaultMaxAttempts));
  const milestoneIds = milestones.map((milestone) => milestone.id);
  if (new Set(milestoneIds).size !== milestoneIds.length) throw new Error("Milestone IDs must be unique.");
  const featureIds = milestones.flatMap((milestone) => milestone.features.map((feature) => feature.id));
  if (new Set(featureIds).size !== featureIds.length) throw new Error("Feature IDs must be unique across the plan.");
  const plan: HorizonPlan = {
    schemaVersion: "2.0",
    sessionId,
    goal: raw.goal.trim(),
    autonomy,
    status: raw.status && PLAN_STATUSES.has(raw.status) ? raw.status : "planning",
    createdAt: raw.createdAt ?? now(),
    completedAt: raw.completedAt ?? null,
    milestones,
    sessionSkills: Array.isArray(raw.sessionSkills) ? [...new Set(raw.sessionSkills.filter((name): name is string => typeof name === "string"))] : [],
    stats: { totalFeatures: 0, completedFeatures: 0, failedFeatures: 0, totalAttempts: 0 },
  };
  recomputeStats(plan);
  return plan;
}

function normalizeMilestone(input: HorizonMilestone, index: number, defaultMaxAttempts: number): HorizonMilestone {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || typeof input.name !== "string") {
    throw new Error(`Milestone ${index + 1} requires id and name.`);
  }
  assertSafeId("milestone ID", input.id);
  if (!Array.isArray(input.features)) throw new Error(`Milestone ${input.id} features must be an array.`);
  return {
    id: input.id,
    name: input.name,
    description: typeof input.description === "string" ? input.description : "",
    status: ITEM_STATUSES.has(input.status) ? input.status : "pending",
    order: Number.isFinite(input.order) ? input.order : index + 1,
    features: input.features.map((feature, featureIndex) => normalizeFeature(feature, featureIndex, defaultMaxAttempts)),
  };
}

function normalizeFeature(input: HorizonFeature, index: number, defaultMaxAttempts: number): HorizonFeature {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || typeof input.name !== "string") {
    throw new Error(`Feature ${index + 1} requires id and name.`);
  }
  assertSafeId("feature ID", input.id);
  return {
    id: input.id,
    name: input.name,
    description: typeof input.description === "string" ? input.description : "",
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === "string")
      : [],
    status: ITEM_STATUSES.has(input.status) ? input.status : "pending",
    order: Number.isFinite(input.order) ? input.order : index + 1,
    attempts: Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
    maxAttempts: Number.isInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : defaultMaxAttempts,
    verification: input.verification ?? { passed: false, score: null, testResults: null, issues: [] },
  };
}

function normalizeHorizonConfig(value: Partial<HorizonRuntimeConfig>): HorizonRuntimeConfig {
  return {
    defaultAutonomy: value.defaultAutonomy === "semi" || value.defaultAutonomy === "supervised" ? value.defaultAutonomy : "full",
    maxRetryCycles: integerWithin(value.maxRetryCycles, 1, 10, DEFAULT_HORIZON_CONFIG.maxRetryCycles),
    evaluationThreshold: integerWithin(value.evaluationThreshold, 0, 100, DEFAULT_HORIZON_CONFIG.evaluationThreshold),
    pauseOnCriticalFailure: typeof value.pauseOnCriticalFailure === "boolean" ? value.pauseOnCriticalFailure : DEFAULT_HORIZON_CONFIG.pauseOnCriticalFailure,
  };
}

function integerWithin(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function recomputeStats(plan: HorizonPlan): void {
  for (const milestone of plan.milestones) {
    if (milestone.features.length === 0) continue;
    if (milestone.features.every((feature) => feature.status === "completed")) milestone.status = "completed";
    else if (milestone.features.some((feature) => feature.status === "in_progress")) milestone.status = "in_progress";
    else if (milestone.features.every((feature) => feature.status === "completed" || (feature.status === "failed" && feature.attempts >= feature.maxAttempts))) milestone.status = "failed";
    else milestone.status = "pending";
  }
  const features = plan.milestones.flatMap((milestone) => milestone.features);
  plan.stats = {
    totalFeatures: features.length,
    completedFeatures: features.filter((feature) => feature.status === "completed").length,
    failedFeatures: features.filter((feature) => feature.status === "failed").length,
    totalAttempts: features.reduce((total, feature) => total + feature.attempts, 0),
  };
}
