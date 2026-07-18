#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { computeTraceScore, scoreGrade, traceCompliance } from "../src/trace-analytics.mjs";

const cwd = process.cwd();
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const root = join(cwd, ".parallax");
const traceDir = join(root, "traces");

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "version" || command === "--version" || command === "-v") return version();
  if (command === "init") return init();
  if (command === "trace") return traceCommand(args);
  if (command === "gate") return gate(args, false);
  if (command === "pre-commit") return gate(["--last"], true);
  throw new CliError(`Unknown command: ${command}`, 1);
}

function help() {
  console.log(`Parallax for Pi ${packageVersion}

Usage: parallax-pi <command>

Commands:
  init                              Initialize .parallax/
  trace list                        List traces
  trace show <id>                   Print a trace
  trace score <id>                  Print score and grade
  trace export <id> [path]          Export pretty JSON
  trace trend                       Show chronological score trend
  trace report                      Show weekly score report
  trace compare <a> <b>             Compare two traces
  trace compliance <id>             Show protocol compliance
  gate [--session <id>] [--min-score <n>]
  pre-commit                        Gate the latest trace
`);
  return 0;
}

function version() {
  console.log(packageVersion);
  return 0;
}

async function init() {
  await mkdir(traceDir, { recursive: true });
  const configPath = join(root, "config.json");
  await writeIfMissing(configPath, `${JSON.stringify({
    strictness: "standard",
    adaptiveProtocol: true,
    autoVerify: true,
    designDocRequired: false,
    minScore: 70,
    maxRetries: 3,
    verificationTimeoutMs: 120000,
    trivialPatterns: ["*.md", "*.txt"],
    highRiskPatterns: ["**/auth/**", "**/*.env*", "**/migrations/**"],
  }, null, 2)}\n`);
  await writeIfMissing(join(root, ".gitignore"), "traces/\nverification/\nhorizon/\n");
  console.log(`Initialized ${root}`);
  return 0;
}

async function traceCommand([subcommand, ...args]) {
  if (subcommand === "list") return listTraces();
  if (subcommand === "show") return showTrace(required(args[0], "trace ID"));
  if (subcommand === "score") return scoreTrace(required(args[0], "trace ID"));
  if (subcommand === "export") return exportTrace(required(args[0], "trace ID"), args[1]);
  if (subcommand === "trend") return trend();
  if (subcommand === "report") return report();
  if (subcommand === "compare") return compare(required(args[0], "first trace ID"), required(args[1], "second trace ID"));
  if (subcommand === "compliance") return compliance(required(args[0], "trace ID"));
  throw new CliError("Usage: parallax-pi trace <list|show|score|export|trend|report|compare|compliance>", 1);
}

async function listTraces() {
  const traces = await loadAllTraces();
  if (!traces.length) return console.log("No traces found."), 0;
  for (const item of traces) {
    const score = computeTraceScore(item.trace);
    console.log(`${item.id.padEnd(38)} ${String(score).padStart(3)}/100 ${scoreGrade(score)}  ${item.trace.verifications?.length ?? 0} checks`);
  }
  return 0;
}

async function showTrace(id) {
  console.log(JSON.stringify(await loadTrace(id), null, 2));
  return 0;
}

async function scoreTrace(id) {
  const score = computeTraceScore(await loadTrace(id));
  console.log(`Coherence Score: ${score}/100 (${scoreGrade(score)})`);
  return 0;
}

async function exportTrace(id, output) {
  const trace = await loadTrace(id);
  const path = resolve(cwd, output ?? `${id}.parallax.json`);
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  console.log(path);
  return 0;
}

async function trend() {
  const traces = (await loadAllTraces()).sort((a, b) => String(a.trace.startedAt).localeCompare(String(b.trace.startedAt)));
  if (!traces.length) return console.log("No traces found."), 0;
  const scores = traces.map((item) => computeTraceScore(item.trace));
  console.log(`Score trend (${scores.length}, average ${Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)}/100)`);
  console.log(scores.map(spark).join(""));
  traces.forEach((item, index) => console.log(`${String(item.trace.startedAt).slice(0, 10)} ${scores[index]}/100 ${item.id}`));
  return 0;
}

async function report() {
  const weeks = new Map();
  for (const item of await loadAllTraces()) {
    const week = isoWeek(String(item.trace.startedAt));
    const values = weeks.get(week) ?? [];
    values.push(computeTraceScore(item.trace));
    weeks.set(week, values);
  }
  if (!weeks.size) return console.log("No traces found."), 0;
  for (const [week, scores] of [...weeks].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${week}: avg ${Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)}/100, ${scores.length} session(s), ${Math.min(...scores)}-${Math.max(...scores)}`);
  }
  return 0;
}

async function compare(leftId, rightId) {
  const [left, right] = await Promise.all([loadTrace(leftId), loadTrace(rightId)]);
  const rows = [
    ["Score", computeTraceScore(left), computeTraceScore(right)],
    ["Phases", left.phases?.length ?? 0, right.phases?.length ?? 0],
    ["Verifications", left.verifications?.length ?? 0, right.verifications?.length ?? 0],
    ["Passes", left.verifications?.filter((item) => item.verdict === "pass").length ?? 0, right.verifications?.filter((item) => item.verdict === "pass").length ?? 0],
  ];
  console.log("Metric           A       B    Delta");
  for (const [label, a, b] of rows) console.log(`${label.padEnd(15)} ${String(a).padStart(3)}     ${String(b).padStart(3)}    ${b - a >= 0 ? "+" : ""}${b - a}`);
  return 0;
}

async function compliance(id) {
  const checks = traceCompliance(await loadTrace(id));
  checks.forEach((check) => console.log(`[${check.complete ? "PASS" : "FAIL"}] ${check.step}`));
  return checks.every((check) => check.complete) ? 0 : 1;
}

async function gate(args, preCommit) {
  const sessionId = option(args, "--session");
  const configured = await loadConfig();
  const minScore = numberOption(args, "--min-score", configured.minScore ?? 70);
  let trace;
  let id;
  if (sessionId) {
    id = sessionId;
    trace = await loadTrace(sessionId);
  } else {
    const traces = await loadAllTraces();
    const latest = traces.sort((a, b) => b.mtime - a.mtime)[0];
    if (!latest) {
      if (preCommit) return console.log("Parallax pre-commit: skipped (no traces found)"), 0;
      throw new CliError("No traces found.", 2);
    }
    ({ id, trace } = latest);
  }
  const score = computeTraceScore(trace);
  const passed = score >= minScore;
  console.log(`Session: ${id}\nCoherence Score: ${score}/100 (${scoreGrade(score)})\nThreshold: ${minScore}/100\nResult: ${passed ? "PASS" : "FAIL"}`);
  return passed ? 0 : 1;
}

async function loadAllTraces() {
  let files;
  try { files = await readdir(traceDir); } catch { return []; }
  const loaded = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    const path = join(traceDir, file);
    try {
      return { id: file.slice(0, -5), trace: JSON.parse(await readFile(path, "utf8")), mtime: (await stat(path)).mtimeMs };
    } catch { return null; }
  }));
  return loaded.filter(Boolean);
}

async function loadTrace(id) {
  if (basename(id) !== id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new CliError(`Invalid trace ID: ${id}`, 1);
  const trace = await readJson(join(traceDir, `${id}.json`));
  if (!trace) throw new CliError(`Trace not found: ${id}`, 1);
  return trace;
}

async function loadConfig() { return await readJson(join(root, "config.json")) ?? {}; }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function writeIfMissing(path, content) { try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); } catch (error) { if (error?.code !== "EEXIST") throw error; } }
function required(value, label) { if (!value) throw new CliError(`Missing ${label}.`, 1); return value; }
function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function numberOption(args, name, fallback) { const value = Number(option(args, name)); return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback; }
function spark(score) { return "_▁▂▃▄▅▆▇█"[Math.min(8, Math.floor(score / 12.5))]; }
function isoWeek(value) { const date = new Date(value); const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); const day = utc.getUTCDay() || 7; utc.setUTCDate(utc.getUTCDate() + 4 - day); const start = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1)); return `${utc.getUTCFullYear()}-W${String(Math.ceil((((utc - start) / 86400000) + 1) / 7)).padStart(2, "0")}`; }
class CliError extends Error { constructor(message, code) { super(message); this.code = code; } }

main().then((code) => { process.exitCode = Number(code) || 0; }).catch((error) => { console.error(error.message ?? error); process.exitCode = error.code ?? 1; });
