import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeCoherenceScore, protocolProgress } from "./state.js";
import type { ParallaxState, ProtocolStep } from "./types.js";

export function formatStatus(state: ParallaxState): string {
  const progress = protocolProgress(state);
  const lines = [
    "PARALLAX STATUS",
    `Mode: ${state.mode}`,
    `Protocol: ${progress.completed}/${progress.total}${progress.next ? ` (next: ${progress.next})` : " (complete)"}`,
    `Verification: ${state.friction.successes}/${state.friction.trials} passed; ${state.friction.retriesLeft} retries left`,
    `Coherence: ${computeCoherenceScore(state)}/100`,
  ];
  if (state.friction.lastFailure) lines.push(`Last failure: ${state.friction.lastFailure.slice(-1_500)}`);
  return lines.join("\n");
}

export function formatTrace(state: ParallaxState): string {
  const steps = (["ambiguity", "invariants", "gate", "design", "commit", "summary"] as ProtocolStep[])
    .map((step) => `[${state.protocol.completed[step] ? "x" : " "}] ${step}${state.protocol.evidence[step] ? ` — ${state.protocol.evidence[step]}` : ""}`)
    .join("\n");
  const checks = state.trace.verifications.length === 0
    ? "No verification runs recorded."
    : state.trace.verifications.slice(-20).map((record) =>
      `[${record.verdict.toUpperCase()}] ${record.command ?? "not detected"} (${record.durationMs}ms)${record.files.length ? ` — ${record.files.join(", ")}` : ""}`,
    ).join("\n");
  return `${formatStatus(state)}\n\nPROTOCOL\n${steps}\n\nVERIFICATION\n${checks}`;
}

export function formatPrComment(state: ParallaxState): string {
  const score = computeCoherenceScore(state);
  const known = state.trace.verifications.filter((record) => record.verdict !== "skipped");
  const passes = known.filter((record) => record.verdict === "pass").length;
  const files = [...new Set(state.trace.verifications.flatMap((record) => record.files))];
  return [
    "## Parallax Trace",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Coherence | ${score}/100 |`,
    `| Protocol steps | ${protocolProgress(state).completed}/6 |`,
    `| Verification | ${passes}/${known.length} passed |`,
    `| Files observed | ${files.length} |`,
    "",
    files.length ? `Files: ${files.map((file) => `\`${file}\``).join(", ")}` : "No file mutations recorded.",
  ].join("\n");
}

export async function exportTrace(state: ParallaxState, cwd: string, finalize = false): Promise<string> {
  const dir = join(cwd, ".parallax", "traces");
  await mkdir(dir, { recursive: true });
  const safeSessionId = state.trace.sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, `${safeSessionId}.json`);
  const trace = {
    ...state.trace,
    endedAt: finalize ? new Date().toISOString() : state.trace.endedAt,
    coherenceScore: computeCoherenceScore(state),
  };
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return path;
}
