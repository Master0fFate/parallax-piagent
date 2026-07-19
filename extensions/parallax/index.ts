import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../../src/config.js";
import { runDelegates, type DelegateMode, type DelegateResult, type DelegateScope } from "../../src/delegate.js";
import { HorizonStore } from "../../src/horizon.js";
import { extractJson, runHyperplan } from "../../src/hyperplan-runner.js";
import {
  generateAnalysis,
  generateCrossAttacks,
  generateDefenses,
  synthesizeCritiques,
  type HyperplanCritique,
  type HyperplanRound,
} from "../../src/hyperplan.js";
import { classifyShellCommand, isReadOnlyShellCommand } from "../../src/readonly-shell.js";
import { stringifyForTool as limitJson, truncateUtf8 as limitText } from "../../src/text.js";
import {
  checkIn,
  computeCoherenceScore,
  createSnapshot,
  createState,
  effectiveStrictness,
  isPersistedSnapshot,
  missingWriteSteps,
  protocolProgress,
  recordAnalysis,
  recordVerification,
  requiredWriteSteps,
  resetProtocol,
  restoreSnapshots,
  setMode,
} from "../../src/state.js";
import { exportTrace, formatPrComment, formatStatus, formatTrace } from "../../src/trace.js";
import type {
  HorizonAutonomy,
  HorizonDecision,
  HorizonExecutionState,
  HorizonStatus,
  ParallaxConfig,
  ParallaxMode,
  ParallaxState,
  ProtocolStep,
} from "../../src/types.js";
import { runVerification } from "../../src/verify.js";

const STATE_ENTRY = "parallax-pi-state";
const CORE_TOOL = "parallax";
const DELEGATE_TOOL = "parallax_delegate";
const HYPERPLAN_TOOL = "parallax_hyperplan";
const HORIZON_ADVANCE_TOOL = "parallax_horizon_advance";
const HORIZON_TOOLS = ["parallax_horizon_session", "parallax_horizon_plan", "parallax_horizon_memory"];
const SUPERVISOR_TOOLS = new Set([CORE_TOOL, DELEGATE_TOOL, HYPERPLAN_TOOL, HORIZON_ADVANCE_TOOL, ...HORIZON_TOOLS]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export function activeToolsForMode(current: string[], mode: ParallaxMode): string[] {
  const active = new Set(current.filter((name) => !SUPERVISOR_TOOLS.has(name)));
  active.add(CORE_TOOL);
  if (mode !== "build") active.add(DELEGATE_TOOL);
  if (mode === "plan" || mode === "horizon") active.add(HYPERPLAN_TOOL);
  if (mode === "horizon") {
    active.add(HORIZON_ADVANCE_TOOL);
    for (const tool of HORIZON_TOOLS) active.add(tool);
  }
  return [...active];
}

const CoreParams = Type.Object({
  action: StringEnum(["status", "health", "checkin", "mode", "analyze", "verify", "trace", "reset"] as const),
  step: Type.Optional(StringEnum(["ambiguity", "invariants", "gate", "design", "commit", "summary"] as const)),
  mode: Type.Optional(StringEnum(["build", "plan", "debug", "horizon"] as const)),
  evidence: Type.Optional(Type.String({ description: "Required concrete evidence supporting a protocol check-in (minimum 8 characters)" })),
  topic: Type.Optional(Type.String({ description: "Component or change to analyze" })),
  format: Type.Optional(StringEnum(["view", "json", "pr"] as const)),
  verificationScope: Type.Optional(StringEnum(["fast", "full"] as const)),
});

const DelegateTaskParams = Type.Object({
  agent: Type.String({ description: "Delegate role name" }),
  task: Type.String({ description: "Atomic task for the delegate" }),
  cwd: Type.Optional(Type.String({ description: "Existing directory within the trusted project root for this delegate" })),
});

const DelegateParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(DelegateTaskParams, { maxItems: 8 })),
  chain: Type.Optional(Type.Array(DelegateTaskParams, { maxItems: 8 })),
  scope: Type.Optional(StringEnum(["builtin", "user", "project", "all"] as const)),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
});

const HorizonSessionParams = Type.Object({
  action: StringEnum(["init", "status", "list", "config"] as const),
  sessionId: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  autonomy: Type.Optional(StringEnum(["full", "semi", "supervised"] as const)),
  data: Type.Optional(Type.String({ description: "JSON Horizon configuration patch" })),
});

const HorizonPlanParams = Type.Object({
  action: StringEnum(["read", "write", "update-feature", "update-milestone", "read-state", "write-state", "evaluate"] as const),
  sessionId: Type.Optional(Type.String()),
  data: Type.Optional(Type.String({ description: "JSON object for write or write-state" })),
  featureId: Type.Optional(Type.String()),
  milestoneId: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "failed"] as const)),
  protocol: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  verification: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  correctness: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  design: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  edgeCases: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  userPerspective: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
});

const HorizonAdvanceParams = Type.Object({
  sessionId: Type.Optional(Type.String()),
  featureId: Type.Optional(Type.String()),
});

const HorizonMemoryParams = Type.Object({
  action: StringEnum(["append-decision", "read-decisions", "write-research", "read-research", "create-skill", "list-skills", "save-trace"] as const),
  sessionId: Type.Optional(Type.String()),
  featureId: Type.Optional(Type.String()),
  ambiguity: Type.Optional(Type.String()),
  research: Type.Optional(Type.String()),
  decision: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  confidence: Type.Optional(StringEnum(["high", "medium", "low"] as const)),
  findings: Type.Optional(Type.String()),
  sources: Type.Optional(Type.String({ description: "JSON object mapping source labels to URLs" })),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  traceId: Type.Optional(Type.String()),
  trace: Type.Optional(Type.String({ description: "JSON trace value" })),
});

const HyperplanParams = Type.Object({
  mode: StringEnum(["run", "generate", "synthesize"] as const),
  depth: Type.Optional(StringEnum(["focused", "debate"] as const)),
  round: Type.Optional(StringEnum(["analysis", "cross-attack", "defense"] as const)),
  plan: Type.String(),
  angles: Type.Optional(Type.Array(Type.String())),
  force: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.String()),
  findings: Type.Optional(Type.String({ description: "JSON array of critiques or findings" })),
  attacks: Type.Optional(Type.String({ description: "JSON object mapping angle IDs to attacks" })),
});

export default function parallaxPi(pi: ExtensionAPI): void {
  let state = createState("pending", process.cwd());
  let supervisionActive = false;
  let automaticSupervision = false;
  let autoActivationEnabled = true;
  let config: ParallaxConfig = {
    strictness: "standard",
    adaptiveProtocol: true,
    autoActivateOnMutation: true,
    autoVerify: true,
    designDocRequired: false,
    minScore: 70,
    maxRetries: 3,
    verificationTimeoutMs: 120_000,
    trivialPatterns: ["*.md", "*.txt"],
    highRiskPatterns: ["**/auth/**", "**/*.env*", "**/migrations/**"],
  };
  let store = new HorizonStore(process.cwd());
  let pendingFiles = new Set<string>();
  let recoveryWriteUsed = false;
  let persistedPhaseCount = 0;
  let persistedVerificationCount = 0;
  let operationQueue: Promise<unknown> = Promise.resolve();
  let verificationQueue: Promise<unknown> = Promise.resolve();
  const originalEnvironment = {
    mode: process.env.PARALLAX_MODE,
    sessionId: process.env.PARALLAX_SESSION_ID,
    retries: process.env.PARALLAX_FRICTION_RETRIES,
  };

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = operationQueue.then(operation, operation);
    operationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  const persist = (): void => {
    pi.appendEntry(STATE_ENTRY, createSnapshot(state, persistedPhaseCount, persistedVerificationCount));
    persistedPhaseCount = state.trace.phases.length;
    persistedVerificationCount = state.trace.verifications.length;
  };

  const restore = (ctx: ExtensionContext): void => {
    const snapshots = ctx.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "custom" && entry.customType === STATE_ENTRY && isPersistedSnapshot(entry.data)
        ? [entry.data]
        : [],
    );
    state = restoreSnapshots(snapshots, ctx.sessionManager.getSessionId(), ctx.cwd, config.maxRetries);
    state.friction.retriesLeft = Math.min(state.friction.retriesLeft, config.maxRetries);
    persistedPhaseCount = state.trace.phases.length;
    persistedVerificationCount = state.trace.verifications.length;
  };

  const activateModeTools = (mode: ParallaxMode): void => {
    pi.setActiveTools(activeToolsForMode(pi.getActiveTools(), mode));
  };

  const deactivateModeTools = (): void => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !SUPERVISOR_TOOLS.has(name)));
  };

  const updateUi = (ctx: ExtensionContext): void => {
    if (!supervisionActive) {
      ctx.ui.setStatus("parallax", undefined);
      ctx.ui.setWidget("parallax", undefined);
      restoreEnvironment("PARALLAX_MODE", originalEnvironment.mode);
      restoreEnvironment("PARALLAX_SESSION_ID", originalEnvironment.sessionId);
      restoreEnvironment("PARALLAX_FRICTION_RETRIES", originalEnvironment.retries);
      return;
    }
    const progress = protocolProgress(state);
    const verdict = state.friction.lastVerdict ? ` V:${state.friction.lastVerdict}` : "";
    const status = `PX${automaticSupervision ? " AUTO" : ""} ${state.mode} ${progress.completed}/6${verdict}`;
    ctx.ui.setStatus("parallax", ctx.ui.theme.fg(state.friction.lastVerdict === "fail" ? "error" : "accent", status));
    if (state.mode === "plan") {
      const remaining = missingWriteSteps(state, config);
      ctx.ui.setWidget("parallax", [
        ctx.ui.theme.fg("warning", "PARALLAX PLAN — read only"),
        ctx.ui.theme.fg("dim", remaining.length ? `Pending gates: ${remaining.join(", ")}` : "Plan gates satisfied; switch to build when ready."),
      ], { placement: "belowEditor" });
    } else if (state.mode === "horizon") {
      ctx.ui.setWidget("parallax", [
        ctx.ui.theme.fg("accent", "PARALLAX HORIZON — durable execution"),
        ctx.ui.theme.fg("dim", `Session: ${state.horizonSessionId ?? "not initialized"}`),
      ], { placement: "belowEditor" });
    } else {
      ctx.ui.setWidget("parallax", undefined);
    }
    process.env.PARALLAX_MODE = state.mode;
    process.env.PARALLAX_SESSION_ID = state.trace.sessionId;
    process.env.PARALLAX_FRICTION_RETRIES = String(state.friction.retriesLeft);
  };

  const setRuntimeMode = (mode: ParallaxMode, ctx: ExtensionContext, automatic = false): string => {
    supervisionActive = true;
    automaticSupervision = automatic;
    setMode(state, mode);
    activateModeTools(mode);
    persist();
    updateUi(ctx);
    return `Parallax mode: ${mode}.${mode === "plan" ? " Writes and mutating shell commands are blocked." : ""}`;
  };

  const verify = (
    ctx: ExtensionContext,
    files: string[],
    thorough: boolean,
    signal?: AbortSignal,
  ): Promise<string> => {
    const execute = async (): Promise<string> => {
      if (!ctx.isProjectTrusted()) {
        const message = "Verification skipped because this project is not trusted. Trust the project before executing project-defined checks.";
        recordVerification(state, {
          timestamp: new Date().toISOString(),
          command: null,
          files,
          verdict: "skipped",
          exitCode: null,
          durationMs: 0,
          output: message,
        }, config.maxRetries);
        persist();
        updateUi(ctx);
        return message;
      }
      const result = await runVerification(ctx.cwd, config, files, thorough, signal);
      recordVerification(state, result, config.maxRetries);
      persist();
      updateUi(ctx);
      if (result.verdict === "pass") return `Verification passed in ${result.durationMs}ms: ${result.command}`;
      if (result.verdict === "skipped") return result.output;
      return `Verification failed (${result.exitCode}) with ${state.friction.retriesLeft} retries left.\n${result.output}${result.fullOutputPath ? `\nFull output: ${result.fullOutputPath}` : ""}`;
    };
    const current = verificationQueue.then(execute, execute);
    verificationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  const continueHorizon = async (ctx: ExtensionContext): Promise<void> => {
    if (!supervisionActive || state.mode !== "horizon" || !ctx.isProjectTrusted() || !state.horizonSessionId) return;
    const [plan, execution] = await Promise.all([
      store.readPlan(state.horizonSessionId),
      store.readState(state.horizonSessionId),
    ]);
    if (!plan || plan.autonomy !== "full" || plan.status === "completed" || plan.status === "failed" || execution?.paused) return;
    pi.sendMessage({
      customType: "parallax-horizon-continuation",
      content: `Continue autonomous Horizon session ${plan.sessionId} from its durable checkpoint. Do not stop to summarize while runnable work remains: finish planning if needed, then advance the next feature. Stop only when the plan is terminal or an external blocker has been recorded.`,
      display: false,
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  pi.registerTool({
    name: CORE_TOOL,
    label: "Parallax",
    description: "Control Parallax protocol, modes, analysis, verification, and traces. Use checkin with concrete evidence before file mutations.",
    promptSnippet: "Track Parallax gates, switch modes, verify changes, or inspect the trace",
    promptGuidelines: ["Use parallax checkin actions with concrete evidence before mutating files when Parallax gates are pending."],
    parameters: CoreParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return serial(async () => {
        let text: string;
        switch (params.action) {
          case "status":
            text = formatStatus(state);
            break;
          case "health":
            text = limitJson({
              healthy: true,
              stateSchema: state.schemaVersion,
              traceSchema: state.trace.schemaVersion,
              sessionId: state.trace.sessionId,
              mode: state.mode,
              projectTrusted: ctx.isProjectTrusted(),
              protocol: state.protocol.completed,
              friction: state.friction,
              trace: { phases: state.trace.phases.length, verifications: state.trace.verifications.length },
              activeParallaxTools: pi.getActiveTools().filter((name) => name.startsWith("parallax")),
              config,
            });
            break;
          case "checkin": {
            if (!params.step) throw new Error("checkin requires step.");
            const step = params.step as ProtocolStep;
            if ((step === "commit" || step === "summary") && state.friction.lastVerdict !== "pass") {
              text = `${step} requires a passing verification result from the current session.`;
              break;
            }
            const result = checkIn(state, step, params.evidence);
            if (result.changed) persist();
            text = result.message;
            break;
          }
          case "mode":
            if (!params.mode) throw new Error("mode action requires mode.");
            text = setRuntimeMode(params.mode as ParallaxMode, ctx, automaticSupervision);
            break;
          case "analyze":
            if (!params.topic?.trim()) throw new Error("analyze requires topic.");
            recordAnalysis(state, params.topic.trim());
            persist();
            text = analysisFramework(params.topic.trim());
            break;
          case "verify":
            text = await verify(ctx, [], params.verificationScope === "full", signal);
            break;
          case "trace": {
            const format = params.format ?? "view";
            if (format === "json") text = `Trace exported: ${await exportTrace(state, ctx.cwd)}`;
            else if (format === "pr") text = formatPrComment(state);
            else text = formatTrace(state);
            break;
          }
          case "reset":
            resetProtocol(state, config.maxRetries);
            persist();
            text = "Parallax protocol and friction state reset. Trace history was preserved.";
            break;
        }
        updateUi(ctx);
        return { content: [{ type: "text", text }], details: { action: params.action, score: computeCoherenceScore(state) } };
      });
    },
  });

  registerDelegateTool(pi);
  registerHyperplanTool(pi);
  registerHorizonTools(pi, () => state, (next, ctx) => { state = next; persist(); updateUi(ctx); }, () => store);
  registerHorizonAdvanceTool(pi, () => state, () => config, () => store, verify);

  pi.registerCommand("parallax", {
    description: "Control Parallax or launch a supervised task: /parallax [status|health|plan|build|debug|horizon|verify|reset|auto|off|<request>]",
    handler: async (args, ctx) => {
      const request = args.trim();
      const action = request.toLowerCase() || "status";
      if (["plan", "build", "debug", "horizon"].includes(action)) {
        ctx.ui.notify(setRuntimeMode(action as ParallaxMode, ctx), "info");
      } else if (action === "verify") {
        supervisionActive = true;
        automaticSupervision = false;
        activateModeTools(state.mode);
        updateUi(ctx);
        ctx.ui.notify(await verify(ctx, [], true), state.friction.lastVerdict === "fail" ? "error" : "info");
      } else if (action === "auto") {
        supervisionActive = false;
        automaticSupervision = false;
        autoActivationEnabled = true;
        pendingFiles = new Set();
        recoveryWriteUsed = false;
        deactivateModeTools();
        updateUi(ctx);
        ctx.ui.notify("Parallax is dormant and will auto-activate on the first attempted mutation.", "info");
      } else if (action === "off" || action === "disable") {
        supervisionActive = false;
        automaticSupervision = false;
        autoActivationEnabled = false;
        pendingFiles = new Set();
        recoveryWriteUsed = false;
        deactivateModeTools();
        updateUi(ctx);
        ctx.ui.notify("Parallax supervision and automatic activation are disabled for this session.", "info");
      } else if (action === "health") {
        ctx.ui.notify(`Healthy. State ${state.schemaVersion}; ${state.trace.phases.length} phases; ${state.trace.verifications.length} checks; ${pi.getActiveTools().filter((name) => name.startsWith("parallax")).length} active Parallax tools.`, "info");
      } else if (action === "reset") {
        if (!ctx.hasUI || await ctx.ui.confirm("Reset Parallax?", "Reset protocol and friction state for this session?")) {
          resetProtocol(state, config.maxRetries);
          persist();
          updateUi(ctx);
          ctx.ui.notify("Parallax reset.", "info");
        }
      } else if (action === "status") {
        const runtime = supervisionActive
          ? automaticSupervision ? "automatic supervision for the current agent run" : "manual supervision"
          : autoActivationEnabled ? "dormant; mutation trigger armed" : "disabled";
        ctx.ui.notify(`${formatStatus(state)}\nRuntime: ${runtime}.`, "info");
      } else {
        setRuntimeMode("build", ctx);
        pi.sendUserMessage(`Use Parallax protocol to complete this request:\n\n${request}`);
      }
    },
  });

  pi.registerCommand("horizon", {
    description: "Launch or resume the Horizon autonomous supervisor: /horizon [goal]",
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Horizon requires a trusted project before it can load plans or execute workers.", "warning");
        return;
      }
      const goal = args.trim();
      setRuntimeMode("horizon", ctx);
      let id: string | undefined = state.horizonSessionId ?? undefined;
      if (!goal && id) {
        const activePlan = await store.readPlan(id);
        if (!activePlan || activePlan.status === "completed" || activePlan.status === "failed") id = undefined;
      }
      if (goal) {
        id = `${ctx.sessionManager.getSessionId()}-${Date.now().toString(36)}`;
        await store.init(id, goal);
        state.horizonSessionId = id;
        persist();
        updateUi(ctx);
      } else if (!id) {
        const resumable = (await store.listSessions())
          .filter((session) => session.status === "planning" || session.status === "executing")
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        id = resumable?.id;
        if (id) {
          state.horizonSessionId = id;
          persist();
          updateUi(ctx);
        }
      }
      if (!id) {
        state.horizonSessionId = null;
        persist();
        updateUi(ctx);
        ctx.ui.notify("No resumable Horizon session. Start one with /horizon <goal>.", "warning");
        return;
      }
      const execution = await store.readState(id);
      if (execution?.paused) await store.writeState(id, { paused: false, pauseReason: null });
      ctx.ui.notify(`${goal ? "Started" : "Resuming"} Horizon session ${id}.`, "info");
      pi.sendUserMessage(`Operate as the Horizon autonomous supervisor for session ${id}. ${goal ? `Goal: ${goal}` : "Resume from its durable checkpoint."} Complete research and planning if needed, then execute and verify every feature. Resolve and log ordinary decisions without asking; stop only for completion, exhausted retries, or a genuinely external blocker.`);
    },
  });

  for (const [shortcut, mode] of [
    ["ctrl+alt+p", "plan"],
    ["ctrl+alt+b", "build"],
    ["ctrl+alt+d", "debug"],
    ["ctrl+alt+h", "horizon"],
  ] as const) {
    pi.registerShortcut(shortcut, {
      description: `Switch Parallax to ${mode} mode`,
      handler: async (ctx) => { ctx.ui.notify(setRuntimeMode(mode, ctx), "info"); },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
    store = new HorizonStore(ctx.cwd);
    restore(ctx);
    supervisionActive = false;
    automaticSupervision = false;
    autoActivationEnabled = config.autoActivateOnMutation;
    pendingFiles = new Set();
    recoveryWriteUsed = false;
    deactivateModeTools();
    updateUi(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
    if (supervisionActive) activateModeTools(state.mode);
    else deactivateModeTools();
    updateUi(ctx);
  });

  pi.on("turn_start", async () => {
    recoveryWriteUsed = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const command = event.toolName === "bash" && typeof event.input.command === "string" ? event.input.command : "";
    const shellKind = event.toolName === "bash" ? classifyShellCommand(command) : undefined;
    const isMutation = WRITE_TOOLS.has(event.toolName) || shellKind === "mutation";
    if (!supervisionActive) {
      if (!autoActivationEnabled || !isMutation) return;
      resetProtocol(state, config.maxRetries);
      setRuntimeMode("build", ctx, true);
      const input = event.input as { path?: unknown };
      const path = typeof input.path === "string" ? input.path : undefined;
      const missing = path
        ? missingWriteSteps(state, config, path)
        : requiredWriteSteps("strict", config.designDocRequired).filter((step) => !state.protocol.completed[step]);
      if (ctx.hasUI) ctx.ui.notify("Parallax auto-activated; the first mutation was held until its gates are satisfied.", "info");
      return {
        block: true,
        reason: `Parallax auto-activated on an attempted ${path ? `mutation of ${path}` : "shell mutation"}; no mutation ran. Complete ${missing.join(", ")} using the parallax tool with concrete evidence, then retry.`,
      };
    }
    if (state.mode === "plan") {
      if (WRITE_TOOLS.has(event.toolName)) {
        return { block: true, reason: "Parallax PLAN mode is read-only. Switch with /parallax build." };
      }
      if (event.toolName === "bash" && !isReadOnlyShellCommand(command)) {
        return { block: true, reason: `Parallax PLAN mode blocked a mutating or unrecognized shell command: ${command}` };
      }
    }

    if (!isMutation) return;
    const writeInput = event.input as { path?: unknown };
    const path = typeof writeInput.path === "string" ? writeInput.path : undefined;
    const strictness = path ? effectiveStrictness(path, config) : "strict";
    const missing = path
      ? missingWriteSteps(state, config, path)
      : requiredWriteSteps("strict", config.designDocRequired).filter((step) => !state.protocol.completed[step]);
    if (missing.length) {
      return {
        block: true,
        reason: `Parallax ${strictness} gate blocks ${path ?? "shell mutation"}. Complete: ${missing.join(", ")} using the parallax tool with concrete evidence.`,
      };
    }
    if (state.friction.retriesLeft === 0) {
      if (recoveryWriteUsed) {
        return {
          block: true,
          reason: "Parallax recovery mode allows one corrective mutation per turn until verification passes.",
        };
      }
      recoveryWriteUsed = true;
    }
  });

  pi.on("tool_result", async (event) => {
    if (!supervisionActive) return;
    if (WRITE_TOOLS.has(event.toolName) && !event.isError) {
      const input = event.input as { path?: unknown };
      if (typeof input.path === "string") pendingFiles.add(input.path);
      return;
    }
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (classifyShellCommand(command) === "mutation") pendingFiles.add("(shell mutation)");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!supervisionActive || !config.autoVerify || pendingFiles.size === 0) return;
    const files = [...pendingFiles];
    pendingFiles = new Set();
    const message = await verify(ctx, files, false, ctx.signal);
    pi.sendMessage({
      customType: "parallax-verification",
      content: `[PARALLAX VERIFICATION: ${state.friction.lastVerdict?.toUpperCase() ?? "UNKNOWN"}]\n${message}\nUse this result as evidence. If it failed, diagnose and correct it; if it was skipped, do not claim verified completion.`,
      display: true,
    }, { deliverAs: "steer" });
    if (ctx.hasUI) ctx.ui.notify(message, state.friction.lastVerdict === "fail" ? "error" : "info");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (automaticSupervision) {
      supervisionActive = false;
      automaticSupervision = false;
      pendingFiles = new Set();
      recoveryWriteUsed = false;
      deactivateModeTools();
      updateUi(ctx);
    }
    await continueHorizon(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!supervisionActive) return;
    if (state.mode === "horizon" && ctx.isProjectTrusted() && !state.horizonSessionId) {
      const resumable = (await store.listSessions())
        .filter((session) => session.status === "planning" || session.status === "executing")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (resumable) {
        state.horizonSessionId = resumable.id;
        persist();
        updateUi(ctx);
      }
    }
    const progress = protocolProgress(state);
    const required = missingWriteSteps(state, config);
    const modeInstruction = {
      build: [
        "Act as the Parallax engineering supervisor.",
        "Inspect concrete code before check-ins; every check-in requires specific evidence.",
        "Establish ambiguity and invariants before mutation, add the strict gate for high-risk or shell changes, keep scope coherent, and use verification feedback before claiming completion.",
        "Finish with commit and summary evidence after checks pass.",
      ].join(" "),
      plan: "Act as the Parallax planner. Stay read-only, inspect concrete artifacts, identify state ownership and failure boundaries, use Hyperplan for material risk, and produce an evidence-backed executable plan with acceptance checks.",
      debug: "Act as the Parallax debugger. Reproduce first, audit actual code and evidence skeptically, rank material defects, apply only focused fixes, and do not claim resolution until verification passes.",
      horizon: [
        "Act as the Horizon long-horizon autonomous supervisor.",
        "The initial ambiguity gate is the only ordinary question window; bundle material questions once, then decide and log later ambiguities without asking.",
        "Research the project, create a milestone/feature plan with acceptance criteria, harden complex plans with Hyperplan, and repeatedly use Horizon advance for worker implementation, real verification, strict review, scoring, and retry.",
        "Continue through every runnable checkpoint without asking permission. Stop only at a configured supervision boundary, exhausted retries, completion, or a genuinely external blocker.",
        "After all features, perform a final full verification and report decisions, failures, and residual risk.",
      ].join(" "),
    }[state.mode];
    let horizonSkills = "";
    let horizonRecovery = "";
    if (state.mode === "horizon" && !ctx.isProjectTrusted()) {
      horizonRecovery = "\nHorizon is unavailable until the project is trusted.";
    } else if (state.mode === "horizon" && state.horizonSessionId) {
      const [skills, plan, execution] = await Promise.all([
        store.readSessionSkills(state.horizonSessionId),
        store.readPlan(state.horizonSessionId),
        store.readState(state.horizonSessionId),
      ]);
      horizonSkills = skills.map((skill) => skill.content).join("\n\n").slice(0, 12_000);
      if (plan) horizonRecovery = `\nHorizon session ${state.horizonSessionId}: ${plan.stats.completedFeatures}/${plan.stats.totalFeatures} features complete; phase ${execution?.phase ?? "unknown"}; autonomy ${plan.autonomy}.${execution?.paused ? ` PAUSED: ${execution.pauseReason ?? "manual checkpoint"}.` : ""}`;
    }
    const friction = state.friction.lastFailure
      ? `\nRecovery required (${state.friction.retriesLeft} retries left):\n${state.friction.lastFailure.slice(-2_000)}`
      : "";
    return {
      systemPrompt: `${_event.systemPrompt}\n\n## PARALLAX\nMode: ${state.mode}. Protocol: ${progress.completed}/6. ${required.length ? `Before file mutation complete: ${required.join(", ")}.` : "Write gates satisfied."}\n${modeInstruction}${horizonRecovery}${friction}${horizonSkills ? `\n\n## SESSION SKILLS\n${horizonSkills}` : ""}`,
    };
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (state.trace.phases.length || state.trace.verifications.length) await exportTrace(state, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("parallax", undefined);
    ctx.ui.setWidget("parallax", undefined);
    restoreEnvironment("PARALLAX_MODE", originalEnvironment.mode);
    restoreEnvironment("PARALLAX_SESSION_ID", originalEnvironment.sessionId);
    restoreEnvironment("PARALLAX_FRICTION_RETRIES", originalEnvironment.retries);
    if (state.trace.phases.length || state.trace.verifications.length) await exportTrace(state, ctx.cwd, true);
  });
}

function registerDelegateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "Parallax Delegate",
    description: "Run isolated Pi SDK agents in-process. Supports single, parallel, or chained delegation without recursively loading extensions. Project agents require project trust.",
    parameters: DelegateParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = (params.tasks?.length ?? 0) > 0;
      const hasChain = (params.chain?.length ?? 0) > 0;
      if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
        throw new Error("Provide exactly one delegate mode: agent+task, tasks, or chain.");
      }
      if (!ctx.model) throw new Error("Delegation requires an active model.");
      const mode: DelegateMode = hasSingle ? "single" : hasParallel ? "parallel" : "chain";
      const tasks = hasSingle
        ? [{ agent: params.agent!, task: params.task! }]
        : hasParallel
          ? params.tasks!
          : params.chain!;
      const results = await runDelegates(mode, tasks, {
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        scope: (params.scope ?? "builtin") as DelegateScope,
        projectTrusted: ctx.isProjectTrusted(),
        ...(signal ? { signal } : {}),
        ...(params.concurrency ? { concurrency: params.concurrency } : {}),
        onUpdate: (current) => onUpdate?.({
          content: [{ type: "text", text: formatDelegateProgress(current) }],
          details: {},
        }),
      });
      const succeeded = results.filter((result) => result.success).length;
      if (succeeded === 0) throw new Error(results.map((result) => result.error ?? result.output).join("\n\n"));
      return {
        content: [{ type: "text", text: limitText(formatDelegateResults(results)) }],
        details: {},
      };
    },
  });
}

function registerHyperplanTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: HYPERPLAN_TOOL,
    label: "Hyperplan",
    description: "Harden non-trivial plans through adaptive adversarial analysis. Trivial plans skip automatically; synthesis de-duplicates findings.",
    parameters: HyperplanParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.mode === "run") {
        if (!ctx.model) throw new Error("Hyperplan run requires an active model.");
        const result = await runHyperplan({
          plan: params.plan,
          depth: params.depth ?? "focused",
          ...(params.context ? { context: params.context } : {}),
          ...(params.angles ? { angles: params.angles } : {}),
          ...(params.force !== undefined ? { force: params.force } : {}),
        }, async (tasks) => runDelegates("parallel", tasks, {
          cwd: ctx.cwd,
          model: ctx.model!,
          thinkingLevel: pi.getThinkingLevel(),
          scope: "builtin",
          projectTrusted: ctx.isProjectTrusted(),
          ...(signal ? { signal } : {}),
          onUpdate: (current) => onUpdate?.({
            content: [{ type: "text", text: formatDelegateProgress(current) }],
            details: {},
          }),
        }));
        return textResult(limitText(result.markdown));
      }
      if (params.mode === "synthesize") {
        if (!params.findings) throw new Error("synthesize requires findings JSON.");
        const critiques = parseJson<HyperplanCritique[]>(params.findings, "findings");
        return textResult(limitText(synthesizeCritiques(critiques).markdown));
      }

      const round = (params.round ?? "analysis") as HyperplanRound;
      if (round === "analysis") {
        const result = generateAnalysis(params.plan, {
          ...(params.angles ? { requestedAngles: params.angles } : {}),
          ...(params.force !== undefined ? { force: params.force } : {}),
          ...(params.context ? { context: params.context } : {}),
        });
        if (result.prompts.length === 0) {
          return textResult(`${result.assessment.reason}\nHyperplan skipped. Set force=true to override.`);
        }
        const output = `${result.assessment.reason}\n\n${result.prompts.map((item) => `=== ${item.angleId} ===\n${item.prompt}`).join("\n\n")}`;
        return textResult(limitText(output));
      }
      if (round === "cross-attack") {
        if (!params.findings) throw new Error("cross-attack requires findings JSON.");
        const prompts = generateCrossAttacks(params.plan, parseJson<HyperplanCritique[]>(params.findings, "findings"), params.angles);
        return textResult(limitText(prompts.map((item) => `=== ${item.angleId} ===\n${item.prompt}`).join("\n\n")));
      }
      if (!params.attacks) throw new Error("defense requires attacks JSON.");
      const prompts = generateDefenses(params.plan, parseJson<Record<string, unknown[]>>(params.attacks, "attacks"), params.angles);
      return textResult(limitText(prompts.map((item) => `=== ${item.angleId} ===\n${item.prompt}`).join("\n\n")));
    },
  });
}

function registerHorizonTools(
  pi: ExtensionAPI,
  getState: () => ParallaxState,
  setState: (state: ParallaxState, ctx: ExtensionContext) => void,
  getStore: () => HorizonStore,
): void {
  const sessionId = (provided: string | undefined, ctx: ExtensionContext): string =>
    provided ?? getState().horizonSessionId ?? ctx.sessionManager.getSessionId();

  pi.registerTool({
    name: HORIZON_TOOLS[0]!,
    label: "Horizon Session",
    description: "Initialize, list, or inspect project-local durable Horizon sessions. sessionId defaults to the active Pi session.",
    parameters: HorizonSessionParams,
    async execute(_id, params, _signal, _update, ctx) {
      requireTrustedProject(ctx, "Horizon session storage");
      const store = getStore();
      if (params.action === "list") return textResult(JSON.stringify(await store.listSessions(), null, 2));
      if (params.action === "config") {
        return textResult(limitJson(params.data
          ? await store.saveConfig(parseJson(params.data, "data"))
          : await store.loadConfig()));
      }
      const id = sessionId(params.sessionId, ctx);
      if (params.action === "init") {
        if (!params.goal?.trim()) throw new Error("init requires goal.");
        const plan = await store.init(id, params.goal.trim(), params.autonomy as HorizonAutonomy | undefined);
        const state = getState();
        state.horizonSessionId = id;
        setMode(state, "horizon");
        setState(state, ctx);
        return textResult(`Horizon session initialized: ${id}\n${summarizePlan(plan)}`);
      }
      return textResult(limitJson(await store.status(id)));
    },
  });

  pi.registerTool({
    name: HORIZON_TOOLS[1]!,
    label: "Horizon Plan",
    description: "Read/write Horizon plans and execution state, update milestones/features, or evaluate completed work.",
    parameters: HorizonPlanParams,
    async execute(_id, params, _signal, _update, ctx) {
      requireTrustedProject(ctx, "Horizon plan storage");
      const store = getStore();
      const id = sessionId(params.sessionId, ctx);
      switch (params.action) {
        case "read": {
          const plan = await store.readPlan(id);
          if (!plan) throw new Error(`Horizon session not found: ${id}`);
          return textResult(limitJson(plan));
        }
        case "write": {
          if (!params.data) throw new Error("write requires data JSON.");
          return textResult(summarizePlan(await store.writePlan(id, parseJson(params.data, "data"))));
        }
        case "update-feature":
          if (!params.featureId || !params.status) throw new Error("update-feature requires featureId and status.");
          return textResult(summarizePlan(await store.updateFeature(id, params.featureId, params.status as HorizonStatus)));
        case "update-milestone":
          if (!params.milestoneId || !params.status) throw new Error("update-milestone requires milestoneId and status.");
          return textResult(summarizePlan(await store.updateMilestone(id, params.milestoneId, params.status as HorizonStatus)));
        case "read-state":
          return textResult(limitJson(await store.readState(id)));
        case "write-state":
          if (!params.data) throw new Error("write-state requires data JSON.");
          return textResult(limitJson(await store.writeState(id, parseJson<Partial<HorizonExecutionState>>(params.data, "data"))));
        case "evaluate": {
          const keys = ["protocol", "verification", "correctness", "design", "edgeCases", "userPerspective"] as const;
          if (!params.featureId || keys.some((key) => params[key] === undefined)) throw new Error(`evaluate requires featureId and scores: ${keys.join(", ")}.`);
          const result = await store.evaluateFeature(id, params.featureId, Object.fromEntries(keys.map((key) => [key, params[key]])) as Record<(typeof keys)[number], number>);
          return textResult(`Evaluation: ${result.passed ? "PASS" : "FAIL"} (${result.score}/100)`);
        }
      }
    },
  });

  pi.registerTool({
    name: HORIZON_TOOLS[2]!,
    label: "Horizon Memory",
    description: "Manage Horizon decisions, research, session skills, and archived traces without separate repetitive tools.",
    parameters: HorizonMemoryParams,
    async execute(_id, params, _signal, _update, ctx) {
      requireTrustedProject(ctx, "Horizon memory");
      const store = getStore();
      const id = sessionId(params.sessionId, ctx);
      switch (params.action) {
        case "append-decision": {
          for (const field of ["ambiguity", "research", "decision", "rationale"] as const) if (!params[field]) throw new Error(`append-decision requires ${field}.`);
          const decision: Omit<HorizonDecision, "timestamp"> = {
            featureId: params.featureId ?? null,
            ambiguity: params.ambiguity!,
            research: params.research!,
            decision: params.decision!,
            rationale: params.rationale!,
            confidence: params.confidence ?? "medium",
          };
          await store.appendDecision(id, decision);
          return textResult("Decision logged.");
        }
        case "read-decisions":
          return textResult(limitJson(await store.readDecisions(id)));
        case "write-research":
          if (!params.findings) throw new Error("write-research requires findings.");
          await store.writeResearch(id, params.findings, params.sources ? parseJson<Record<string, string>>(params.sources, "sources") : {});
          return textResult("Research saved.");
        case "read-research":
          return textResult(limitJson(await store.readResearch(id)));
        case "create-skill":
          if (!params.name || !params.description || !params.content) throw new Error("create-skill requires name, description, and content.");
          return textResult(`Skill created: ${await store.createSkill(id, params.name, params.description, params.content)}`);
        case "list-skills":
          return textResult(limitJson((await store.readSessionSkills(id)).map((skill) => skill.name)));
        case "save-trace":
          if (!params.traceId || !params.trace) throw new Error("save-trace requires traceId and trace JSON.");
          return textResult(`Trace saved: ${await store.saveTrace(id, params.traceId, parseJson(params.trace, "trace"))}`);
      }
    },
  });
}

function formatDelegateProgress(results: DelegateResult[]): string {
  const complete = results.filter((result) => result.durationMs >= 0 && result.output !== "(pending)").length;
  const running = results.length - complete;
  return `Delegates: ${complete}/${results.length} complete${running ? `, ${running} running` : ""}.`;
}

function formatDelegateResults(results: DelegateResult[]): string {
  const totalCost = results.reduce((sum, result) => sum + result.usage.cost, 0);
  return [
    `Delegation: ${results.filter((result) => result.success).length}/${results.length} succeeded; cost $${totalCost.toFixed(4)}`,
    ...results.map((result) => `\n## ${result.agent} [${result.success ? "complete" : "failed"}]${result.model ? ` (${result.model})` : ""}\n${result.output}`),
  ].join("\n");
}

function registerHorizonAdvanceTool(
  pi: ExtensionAPI,
  getState: () => ParallaxState,
  getConfig: () => ParallaxConfig,
  getStore: () => HorizonStore,
  verify: (ctx: ExtensionContext, files: string[], thorough: boolean, signal?: AbortSignal) => Promise<string>,
): void {
  pi.registerTool({
    name: HORIZON_ADVANCE_TOOL,
    label: "Horizon Advance",
    description: "Advance one durable Horizon feature through an isolated worker, real project verification, evidence-based review, scoring, and checkpoint update. One feature per call preserves recovery boundaries.",
    parameters: HorizonAdvanceParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      requireTrustedProject(ctx, "Horizon execution");
      if (!ctx.model) throw new Error("Horizon advance requires an active model.");
      const state = getState();
      const config = getConfig();
      const missing = requiredWriteSteps("strict", config.designDocRequired)
        .filter((step) => !state.protocol.completed[step]);
      if (missing.length) throw new Error(`Horizon execution requires strict gates: ${missing.join(", ")}.`);

      const sessionId = params.sessionId ?? state.horizonSessionId ?? ctx.sessionManager.getSessionId();
      const store = getStore();
      const [plan, execution, runtimeConfig] = await Promise.all([
        store.readPlan(sessionId),
        store.readState(sessionId),
        store.loadConfig(),
      ]);
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`);
      if (execution?.paused) throw new Error(`Horizon session is paused: ${execution.pauseReason ?? "manual pause"}. Resume it before advancing.`);
      const ordered = [...plan.milestones]
        .sort((left, right) => left.order - right.order)
        .flatMap((milestone) => [...milestone.features].sort((left, right) => left.order - right.order));
      const feature = params.featureId
        ? ordered.find((candidate) => candidate.id === params.featureId)
        : ordered.find((candidate) => candidate.status === "in_progress")
          ?? ordered.find((candidate) => candidate.status === "failed" && candidate.attempts < candidate.maxAttempts)
          ?? ordered.find((candidate) => candidate.status === "pending");
      if (!feature) return textResult("No runnable Horizon feature remains.");
      if (feature.status === "completed") return textResult(`Feature ${feature.id} is already complete.`);

      const runningPlan = await store.updateFeature(sessionId, feature.id, "in_progress");
      const activeMilestone = runningPlan.milestones.find((milestone) => milestone.features.some((candidate) => candidate.id === feature.id))!;
      const runningFeature = activeMilestone.features.find((candidate) => candidate.id === feature.id)!;
      await store.writeState(sessionId, { phase: "execute", activeMilestoneId: activeMilestone.id, activeFeatureId: feature.id });
      const workerPrompt = [
        `Horizon goal: ${plan.goal}`,
        `Feature: ${feature.id} — ${feature.name}`,
        feature.description,
        `Acceptance criteria:\n${feature.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") || "- Satisfy the feature description with verified behavior."}`,
        `Attempt: ${runningFeature.attempts}/${runningFeature.maxAttempts}`,
        "Implement this feature completely in the current project. Keep scope limited to the feature and report changed files and targeted checks.",
      ].join("\n\n");
      const workerResults = await runDelegates("single", [{ agent: "worker", task: workerPrompt }], {
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        scope: "builtin",
        projectTrusted: ctx.isProjectTrusted(),
        allowMutations: true,
        ...(signal ? { signal } : {}),
        onUpdate: (current) => onUpdate?.({ content: [{ type: "text", text: formatDelegateProgress(current) }], details: {} }),
      });
      const worker = workerResults[0]!;
      if (!worker.success) {
        const failedPlan = await store.updateFeature(sessionId, feature.id, "failed");
        const failedFeature = failedPlan.milestones.flatMap((milestone) => milestone.features).find((candidate) => candidate.id === feature.id)!;
        const exhausted = failedFeature.attempts >= failedFeature.maxAttempts;
        const shouldPause = plan.autonomy === "supervised" || (runtimeConfig.pauseOnCriticalFailure && exhausted);
        await store.writeState(sessionId, {
          phase: failedPlan.status === "failed" ? "complete" : "execute",
          activeMilestoneId: null,
          activeFeatureId: null,
          paused: shouldPause,
          pauseReason: shouldPause ? exhausted ? `Retry cap exhausted for ${feature.id}.` : `Supervised checkpoint after ${feature.id}.` : null,
        });
        await store.appendDecision(sessionId, {
          featureId: feature.id,
          ambiguity: "Worker execution failed",
          research: worker.error ?? worker.output,
          decision: "Mark attempt failed",
          rationale: "The isolated worker did not complete successfully; preserve the checkpoint for retry.",
          confidence: "high",
        });
        return textResult(`Feature ${feature.id} attempt failed before verification (${failedFeature.attempts}/${failedFeature.maxAttempts}).${shouldPause ? " Horizon paused." : " A later advance may retry it."}\n${worker.error ?? worker.output}`);
      }

      const verificationMessage = await verify(ctx, [], true, signal);
      const verificationPassed = getState().friction.lastVerdict === "pass";
      let review = { correctness: 50, design: 50, edgeCases: 50, userPerspective: 50, issues: [] as string[] };
      let reviewerOutput = "Reviewer skipped because project verification did not pass.";
      if (verificationPassed) {
        const reviewPrompt = [
          `Review Horizon feature ${feature.id}: ${feature.name}`,
          `Acceptance criteria: ${JSON.stringify(feature.acceptanceCriteria)}`,
          `Worker handoff:\n${worker.output}`,
          "Inspect the actual repository. Return JSON only: {\"correctness\":0-100,\"design\":0-100,\"edgeCases\":0-100,\"userPerspective\":0-100,\"issues\":[\"material issue\"]}.",
        ].join("\n\n");
        const reviewer = (await runDelegates("single", [{ agent: "reviewer", task: reviewPrompt }], {
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: pi.getThinkingLevel(),
          scope: "builtin",
          projectTrusted: ctx.isProjectTrusted(),
          ...(signal ? { signal } : {}),
          onUpdate: (current) => onUpdate?.({ content: [{ type: "text", text: formatDelegateProgress(current) }], details: {} }),
        }))[0]!;
        reviewerOutput = reviewer.output;
        review = parseReview(reviewer.output);
      }

      const evaluation = await store.evaluateFeature(sessionId, feature.id, {
        protocol: 100,
        verification: verificationPassed ? 100 : 0,
        correctness: review.correctness,
        design: review.design,
        edgeCases: review.edgeCases,
        userPerspective: review.userPerspective,
      }, {
        testResults: verificationMessage,
        issues: verificationPassed ? review.issues : [verificationMessage],
      });
      const updatedPlan = await store.updateFeature(sessionId, feature.id, evaluation.passed ? "completed" : "failed");
      const updatedFeature = updatedPlan.milestones.flatMap((milestone) => milestone.features).find((candidate) => candidate.id === feature.id)!;
      const milestone = updatedPlan.milestones.find((candidate) => candidate.features.some((item) => item.id === feature.id))!;
      const exhausted = !evaluation.passed && updatedFeature.attempts >= updatedFeature.maxAttempts;
      const supervisedPause = plan.autonomy === "supervised";
      const milestonePause = plan.autonomy === "semi" && (milestone.status === "completed" || milestone.status === "failed");
      const criticalPause = runtimeConfig.pauseOnCriticalFailure && exhausted;
      const shouldPause = updatedPlan.status !== "completed" && (supervisedPause || milestonePause || criticalPause);
      const pauseReason = criticalPause
        ? `Retry cap exhausted for ${feature.id}.`
        : supervisedPause
          ? `Supervised checkpoint after ${feature.id}.`
          : milestonePause
            ? `Milestone checkpoint after ${milestone.id}.`
            : null;
      await store.writeState(sessionId, {
        phase: updatedPlan.status === "completed" || updatedPlan.status === "failed" ? "complete" : "execute",
        activeMilestoneId: null,
        activeFeatureId: null,
        paused: shouldPause,
        pauseReason,
      });
      return textResult(limitText([
        `Feature ${feature.id}: ${evaluation.passed ? "PASS" : "FAIL"} (${evaluation.score}/100).${shouldPause ? ` Horizon paused: ${pauseReason}` : updatedPlan.status === "completed" ? " Horizon plan complete." : updatedPlan.status === "failed" ? " Horizon plan ended with exhausted failures." : " Continue with the next checkpoint."}`,
        verificationMessage,
        `Worker:\n${worker.output}`,
        `Reviewer:\n${reviewerOutput}`,
      ].join("\n\n")));
    },
  });
}

function parseReview(output: string): { correctness: number; design: number; edgeCases: number; userPerspective: number; issues: string[] } {
  const parsed = extractJson(output);
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const score = (key: string): number => typeof value[key] === "number" && Number.isFinite(value[key])
    ? Math.max(0, Math.min(100, value[key]))
    : 50;
  return {
    correctness: score("correctness"),
    design: score("design"),
    edgeCases: score("edgeCases"),
    userPerspective: score("userPerspective"),
    issues: Array.isArray(value.issues) ? value.issues.filter((issue): issue is string => typeof issue === "string") : [],
  };
}

function analysisFramework(topic: string): string {
  return [
    `PARALLAX ANALYSIS: ${topic}`,
    "1. Nominal result and acceptance evidence",
    "2. Empty, malformed, boundary, and failure states",
    "3. State owner and single source of truth",
    "4. Feedback, logs, and user-visible recovery",
    "5. Deletion/import blast radius and compatibility",
    "6. Async ordering, races, cancellation, and idempotency",
    "7. Security, performance, rollback, and focused tests",
    "Inspect concrete code before answering; omit vectors that are demonstrably immaterial.",
  ].join("\n");
}

function parseJson<T = unknown>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${String(error)}`);
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function requireTrustedProject(ctx: ExtensionContext, feature: string): void {
  if (!ctx.isProjectTrusted()) throw new Error(`${feature} requires a trusted Pi project.`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function summarizePlan(plan: { status: string; stats: { completedFeatures: number; totalFeatures: number; failedFeatures: number; totalAttempts: number } }): string {
  return `Plan ${plan.status}: ${plan.stats.completedFeatures}/${plan.stats.totalFeatures} complete, ${plan.stats.failedFeatures} failed, ${plan.stats.totalAttempts} attempts.`;
}

