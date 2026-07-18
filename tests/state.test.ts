import { describe, expect, it } from "vitest";
import {
  checkIn,
  computeCoherenceScore,
  createSnapshot,
  createState,
  effectiveStrictness,
  matchesGlob,
  missingWriteSteps,
  recordVerification,
  requiredWriteSteps,
  restoreSnapshots,
} from "../src/state.js";
import type { ParallaxConfig } from "../src/types.js";

const config = (strictness: ParallaxConfig["strictness"]): ParallaxConfig => ({
  strictness,
  adaptiveProtocol: true,
  autoVerify: true,
  designDocRequired: false,
  minScore: 70,
  maxRetries: 3,
  verificationTimeoutMs: 1000,
  trivialPatterns: ["*.md"],
  highRiskPatterns: ["**/auth/**"],
});

describe("protocol state", () => {
  it("uses adaptive write gates", () => {
    expect(requiredWriteSteps("relaxed", false)).toEqual(["ambiguity"]);
    expect(requiredWriteSteps("standard", false)).toEqual(["ambiguity", "invariants"]);
    expect(requiredWriteSteps("strict", false)).toEqual(["ambiguity", "invariants", "gate"]);
  });

  it("includes the full prerequisite chain when design is required", () => {
    expect(requiredWriteSteps("relaxed", true)).toEqual(["ambiguity", "invariants", "gate", "design"]);
  });

  it("enforces protocol order", () => {
    const state = createState("s", "/tmp");
    expect(checkIn(state, "invariants").changed).toBe(false);
    expect(checkIn(state, "ambiguity", "LOW: request is specific").changed).toBe(true);
    expect(checkIn(state, "invariants", "state lives in store").changed).toBe(true);
    expect(checkIn(state, "gate", "tests defined").changed).toBe(true);
  });

  it("requires evidence and remains idempotent", () => {
    const state = createState("s", "/tmp");
    expect(checkIn(state, "ambiguity", "LOW").changed).toBe(false);
    checkIn(state, "ambiguity", "LOW: scoped request");
    expect(checkIn(state, "ambiguity", "different evidence").changed).toBe(false);
    expect(state.trace.phases).toHaveLength(1);
  });

  it("reports missing gates", () => {
    const state = createState("s", "/tmp");
    checkIn(state, "ambiguity", "LOW: scoped request");
    expect(missingWriteSteps(state, config("standard"))).toEqual(["invariants"]);
  });

  it("adapts strictness by file risk without weakening high-risk paths", () => {
    const current = config("standard");
    expect(effectiveStrictness("README.md", current)).toBe("relaxed");
    expect(effectiveStrictness("src/auth/session.ts", current)).toBe("strict");
    expect(effectiveStrictness("src/main.ts", current)).toBe("standard");
  });

  it("matches portable glob patterns", () => {
    expect(matchesGlob("docs/guide.md", "*.md")).toBe(true);
    expect(matchesGlob("src\\auth\\token.ts", "**/auth/**")).toBe(true);
    expect(matchesGlob("src/author.ts", "**/auth/**")).toBe(false);
  });
});

describe("friction", () => {
  it("decrements retries on consecutive failures", () => {
    const state = createState("s", "/tmp");
    for (let index = 0; index < 3; index++) {
      recordVerification(state, {
        timestamp: new Date().toISOString(), command: "test", files: [], verdict: "fail", exitCode: 1, durationMs: 1, output: "bad",
      }, 3);
    }
    expect(state.friction.retriesLeft).toBe(0);
    expect(state.friction.consecutiveFailures).toBe(3);
  });

  it("resets retries on success", () => {
    const state = createState("s", "/tmp");
    recordVerification(state, {
      timestamp: "", command: "test", files: [], verdict: "fail", exitCode: 1, durationMs: 1, output: "bad",
    }, 3);
    recordVerification(state, {
      timestamp: "", command: "test", files: [], verdict: "pass", exitCode: 0, durationMs: 1, output: "ok",
    }, 3);
    expect(state.friction.retriesLeft).toBe(3);
    expect(state.friction.lastFailure).toBeNull();
  });

  it("does not count skipped checks as trials", () => {
    const state = createState("s", "/tmp");
    recordVerification(state, {
      timestamp: "", command: null, files: [], verdict: "skipped", exitCode: null, durationMs: 1, output: "none",
    }, 3);
    expect(state.friction.trials).toBe(0);
  });

  it("persists trace history as deltas rather than repeated full snapshots", () => {
    const state = createState("s", "/tmp");
    checkIn(state, "ambiguity", "LOW: scoped");
    const first = createSnapshot(state, 0, 0);
    checkIn(state, "invariants", "state owner mapped");
    const second = createSnapshot(state, 1, 0);
    expect(first.phases).toHaveLength(1);
    expect(second.phases).toHaveLength(1);
    const restored = restoreSnapshots([first, second], "s", "/tmp", 3);
    expect(restored.trace.phases.map((phase) => phase.step)).toEqual(["ambiguity", "invariants"]);
  });

  it("scores evidence and verification rather than ceremony alone", () => {
    const state = createState("s", "/tmp");
    checkIn(state, "ambiguity", "LOW: scoped");
    checkIn(state, "invariants", "store, logs, imports, ordering");
    checkIn(state, "gate", "npm test");
    checkIn(state, "commit", "Full solution selected");
    checkIn(state, "summary", "Implemented and verified");
    recordVerification(state, {
      timestamp: "", command: "npm test", files: ["x.ts"], verdict: "pass", exitCode: 0, durationMs: 1, output: "ok",
    }, 3);
    expect(computeCoherenceScore(state)).toBeGreaterThanOrEqual(85);
  });
});
