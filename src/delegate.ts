import { link, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { truncateUtf8 } from "./text.js";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type DelegateScope = "builtin" | "user" | "project" | "all";
export type DelegateMode = "single" | "parallel" | "chain";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DelegateAgent {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath: string;
}

export interface DelegateTask {
  agent: string;
  task: string;
  cwd?: string;
}

export interface DelegateResult {
  agent: string;
  source: DelegateAgent["source"] | "unknown";
  task: string;
  output: string;
  success: boolean;
  error?: string;
  model?: string;
  durationMs: number;
  toolCalls: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
}

export interface DelegateRunOptions {
  cwd: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  scope: DelegateScope;
  projectTrusted: boolean;
  signal?: AbortSignal;
  concurrency?: number;
  allowMutations?: boolean;
  onUpdate?: (results: DelegateResult[]) => void;
}

const BUILTIN_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
const PROJECT_AGENTS_PATH = [".parallax", "agents"] as const;
const MAX_TASKS = 8;
const MAX_AGENT_NAME_LENGTH = 80;

export async function discoverDelegateAgents(
  cwd: string,
  scope: DelegateScope,
  projectTrusted: boolean,
): Promise<DelegateAgent[]> {
  if ((scope === "project" || scope === "all") && !projectTrusted) {
    throw new Error("Project-local delegate agents require a trusted Pi project.");
  }

  const groups: DelegateAgent[][] = [];
  if (scope === "builtin" || scope === "all") groups.push(await loadAgents(BUILTIN_AGENTS_DIR, "builtin"));
  if (scope === "user" || scope === "all") groups.push(await loadAgents(join(getAgentDir(), "agents"), "user"));
  if (scope === "project" || scope === "all") {
    const projectDirs = await findProjectAgentsDirs(cwd);
    for (const projectDir of projectDirs) groups.push(await loadAgents(projectDir, "project"));
  }

  const agents = new Map<string, DelegateAgent>();
  for (const group of groups) for (const agent of group) agents.set(agent.name, agent);
  return [...agents.values()];
}

export async function resolveDelegateCwd(projectCwd: string, requestedCwd?: string): Promise<string> {
  const root = await findProjectRoot(projectCwd);
  const candidate = await realpath(resolve(root, requestedCwd ?? "."));
  if (!(await stat(candidate)).isDirectory()) throw new Error(`Delegate cwd is not a directory: ${requestedCwd ?? projectCwd}`);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("Delegate cwd must stay within the trusted project directory.");
  }
  return candidate;
}

export async function runDelegates(
  mode: DelegateMode,
  tasks: DelegateTask[],
  options: DelegateRunOptions,
): Promise<DelegateResult[]> {
  if (tasks.length === 0) throw new Error("At least one delegate task is required.");
  if (tasks.length > MAX_TASKS) throw new Error(`Delegate task limit is ${MAX_TASKS}.`);
  if (!options.projectTrusted) throw new Error("Delegation requires a trusted Pi project because delegates load project context files.");
  const agents = await discoverDelegateAgents(options.cwd, options.scope, options.projectTrusted);
  if (options.scope === "project" || options.scope === "all") {
    for (const item of tasks) {
      if (findDelegateAgent(agents, item.agent)) continue;
      const created = await createProjectDelegateAgent(options.cwd, item.agent);
      if (!findDelegateAgent(agents, created.name)) agents.push(created);
    }
  }
  const modelRuntime = await ModelRuntime.create();

  if (mode === "chain") {
    const results: DelegateResult[] = [];
    let previous = "";
    for (const item of tasks) {
      const task = item.task.replace(/\{previous\}/g, truncateUtf8(previous, { maxBytes: 20 * 1024 }));
      const result = await runOne({ ...item, task }, agents, modelRuntime, options, results);
      results.push(result);
      options.onUpdate?.([...results]);
      if (!result.success) break;
      previous = result.output;
    }
    return results;
  }

  if (mode === "single") {
    return [await runOne(tasks[0]!, agents, modelRuntime, options, [])];
  }

  const placeholders = tasks.map((task) => pendingResult(task));
  options.onUpdate?.([...placeholders]);
  return mapConcurrent(tasks, options.concurrency ?? 4, async (task, index) => {
    const result = await runOne(task, agents, modelRuntime, options, placeholders);
    placeholders[index] = result;
    options.onUpdate?.([...placeholders]);
    return result;
  });
}

async function runOne(
  item: DelegateTask,
  agents: DelegateAgent[],
  modelRuntime: ModelRuntime,
  options: DelegateRunOptions,
  aggregate: DelegateResult[],
): Promise<DelegateResult> {
  const agent = findDelegateAgent(agents, item.agent);
  if (!agent) {
    const hint = options.scope === "builtin" || options.scope === "user"
      ? ` Use scope \"all\" or \"project\" to create it as a reusable project agent.`
      : "";
    return failedResult(item, `Unknown delegate agent ${item.agent}. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}.${hint}`);
  }
  if (!options.allowMutations && agentCanMutate(agent)) {
    return failedResult(item, `Delegate ${agent.name} has mutating tools. Use the verified Horizon advance workflow for implementation workers.`, agent.source);
  }
  if (options.signal?.aborted) return failedResult(item, "Delegation aborted before start.", agent.source);

  const started = Date.now();
  let cwd: string;
  try {
    cwd = await resolveDelegateCwd(options.cwd, item.cwd);
  } catch (error) {
    return failedResult(item, String(error), agent.source);
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [
      `## DELEGATED ROLE: ${agent.name}\n${agent.systemPrompt}\n\nWork only on the delegated task. Return a concise handoff to the parent agent.`,
    ],
  });
  await resourceLoader.reload();

  let model: Model<any>;
  try {
    model = selectDelegateModel(agent, options.model, await modelRuntime.getAvailable(options.model.provider));
  } catch (error) {
    return failedResult(item, String(error), agent.source, Date.now() - started);
  }
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: options.thinkingLevel,
    tools: agent.tools,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const toolCalls: string[] = [];
  let streamingText = "";
  const notify = (): void => {
    const current: DelegateResult = {
      agent: agent.name,
      source: agent.source,
      task: item.task,
      output: truncateUtf8(streamingText, { maxBytes: 4_000 }),
      success: false,
      model: formatModel(model),
      durationMs: Date.now() - started,
      toolCalls: [...toolCalls],
      usage: emptyUsage(),
    };
    options.onUpdate?.([...aggregate.filter((result) => result.durationMs >= 0), current]);
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamingText += event.assistantMessageEvent.delta;
    } else if (event.type === "tool_execution_start") {
      toolCalls.push(event.toolName);
      notify();
    }
  });
  const abort = (): void => { void session.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(`Task: ${item.task}`, { expandPromptTemplates: false, source: "extension" });
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    const stopReason = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
    const stats = session.getSessionStats();
    const output = truncateUtf8((session.getLastAssistantText() ?? streamingText) || "(no output)");
    const error = stopReason === "error" || stopReason === "aborted"
      ? lastAssistant?.role === "assistant" ? lastAssistant.errorMessage ?? stopReason : stopReason
      : undefined;
    return {
      agent: agent.name,
      source: agent.source,
      task: item.task,
      output,
      success: !error,
      ...(error ? { error } : {}),
      model: formatModel(model),
      durationMs: Date.now() - started,
      toolCalls,
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
        cost: stats.cost,
      },
    };
  } catch (error) {
    return failedResult(item, String(error), agent.source, Date.now() - started, toolCalls);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

async function loadAgents(dir: string, source: DelegateAgent["source"]): Promise<DelegateAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const agents: DelegateAgent[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      if (!(await stat(filePath)).isFile()) continue;
      const parsed = parseFrontmatter<Record<string, string>>(await readFile(filePath, "utf8"));
      if (!parsed.frontmatter.name || !parsed.frontmatter.description) continue;
      agents.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        tools: parsed.frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean) ?? ["read", "grep", "find", "ls"],
        ...(parsed.frontmatter.model ? { model: parsed.frontmatter.model } : {}),
        systemPrompt: parsed.body.trim(),
        source,
        filePath,
      });
    } catch {
      // A malformed optional agent must not break all delegation.
    }
  }
  return agents;
}

async function findProjectAgentsDirs(cwd: string): Promise<string[]> {
  const root = await findProjectRoot(cwd);
  const candidates = [
    join(root, CONFIG_DIR_NAME, "agents"),
    join(root, ...PROJECT_AGENTS_PATH),
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) found.push(candidate);
    } catch {
      // An optional project agent directory may not exist yet.
    }
  }
  return found;
}

export async function createProjectDelegateAgent(cwd: string, requestedName: string): Promise<DelegateAgent> {
  const name = normalizeAgentName(requestedName);
  const root = await findProjectRoot(cwd);
  const configDir = await ensureContainedDirectory(root, join(root, PROJECT_AGENTS_PATH[0]));
  const agentsDir = await ensureContainedDirectory(root, join(configDir, PROJECT_AGENTS_PATH[1]));
  const filePath = join(agentsDir, `${name}.md`);
  const title = name.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  const description = `Project-local ${title} specialist.`;
  const systemPrompt = [
    `Act as this project's ${title}.`,
    "",
    "Approach each delegated task as a focused specialist: establish the relevant scope and criteria, inspect the repository evidence before drawing conclusions, apply the standards of this role, and report concrete findings with file paths. Distinguish verified facts from inference, prioritize material issues, and give concise actionable recommendations.",
    "",
    "Remain read-only. Do not modify files or execute mutating commands. Work only on the delegated task and preserve the project's existing conventions and trust boundaries.",
  ].join("\n");
  const content = `---\nname: ${name}\ndescription: ${description}\ntools: read, grep, find, ls\n---\n\n${systemPrompt}\n`;

  const temporaryPath = join(agentsDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }

  const existing = (await loadAgents(agentsDir, "project")).find((agent) => agent.name === name);
  if (!existing) throw new Error(`Project delegate definition ${filePath} exists but is invalid.`);
  return existing;
}

async function findProjectRoot(cwd: string): Promise<string> {
  const start = await realpath(cwd);
  let current = start;
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      // Continue toward the filesystem root.
    }
    const next = dirname(current);
    if (next === current) return start;
    current = next;
  }
}

async function ensureContainedDirectory(root: string, candidate: string): Promise<string> {
  try {
    const existing = await realpath(candidate);
    assertContained(root, existing);
    if (!(await stat(existing)).isDirectory()) throw new Error(`Project delegate path is not a directory: ${candidate}`);
    return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    await mkdir(candidate);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const created = await realpath(candidate);
  assertContained(root, created);
  if (!(await stat(created)).isDirectory()) throw new Error(`Project delegate path is not a directory: ${candidate}`);
  return created;
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("Project delegate agents directory must stay within the trusted project directory.");
  }
}

function normalizeAgentName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_AGENT_NAME_LENGTH || !/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
    throw new Error(`Delegate agent names must be 1-${MAX_AGENT_NAME_LENGTH} letters, numbers, spaces, underscores, or hyphens.`);
  }
  const normalized = trimmed.toLowerCase().replace(/[ _-]+/g, "-").replace(/^-|-$/g, "");
  if (!normalized || !/^[a-z0-9]/.test(normalized)) throw new Error("Delegate agent name must begin with a letter or number.");
  return normalized;
}

function findDelegateAgent(agents: DelegateAgent[], requestedName: string): DelegateAgent | undefined {
  const exact = agents.find((candidate) => candidate.name === requestedName);
  if (exact) return exact;
  try {
    const normalized = normalizeAgentName(requestedName);
    return agents.find((candidate) => candidate.name === normalized);
  } catch {
    return undefined;
  }
}

export function agentCanMutate(agent: Pick<DelegateAgent, "tools">): boolean {
  return agent.tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash");
}

export function selectDelegateModel(
  agent: Pick<DelegateAgent, "name" | "model">,
  parent: Model<any>,
  available: readonly Model<any>[],
): Model<any> {
  const candidates = available.filter((model) => model.provider === parent.provider && model.input.includes("text"));
  if (candidates.length === 0) {
    throw new Error(`No authenticated text model is available from the parent provider (${parent.provider}) for delegate ${agent.name}.`);
  }

  if (agent.model) {
    const requestedId = agent.model.startsWith(`${parent.provider}/`)
      ? agent.model.slice(parent.provider.length + 1)
      : agent.model;
    const requested = candidates.find((model) => model.id === requestedId);
    if (!requested) {
      throw new Error(`Delegate ${agent.name} requests model ${agent.model}, which is not an authenticated model from the parent provider (${parent.provider}).`);
    }
    return requested;
  }

  const active = candidates.find((model) => model.id === parent.id);
  if (!active) {
    throw new Error(`The active model ${formatModel(parent)} is not authenticated for isolated delegation. Configure provider credentials before delegating.`);
  }
  if (agent.name !== "scout" && agent.name !== "critic") return active;

  const minimumContext = Math.min(parent.contextWindow, 32_000);
  const contextQualified = candidates.filter((model) => model.contextWindow >= minimumContext);
  const pool = contextQualified.length > 0 ? contextQualified : candidates;
  return [...pool].sort((left, right) => {
    const costDifference = modelCost(left) - modelCost(right);
    if (costDifference !== 0) return costDifference;
    if (left.id === active.id) return -1;
    if (right.id === active.id) return 1;
    return left.id.localeCompare(right.id);
  })[0]!;
}

function modelCost(model: Model<any>): number {
  return model.cost.input + (model.cost.output * 2) + model.cost.cacheRead + model.cost.cacheWrite;
}

function formatModel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function pendingResult(task: DelegateTask): DelegateResult {
  return {
    agent: task.agent,
    source: "unknown",
    task: task.task,
    output: "(pending)",
    success: false,
    durationMs: -1,
    toolCalls: [],
    usage: emptyUsage(),
  };
}

function failedResult(
  task: DelegateTask,
  error: string,
  source: DelegateResult["source"] = "unknown",
  durationMs = 0,
  toolCalls: string[] = [],
): DelegateResult {
  return {
    agent: task.agent,
    source,
    task: task.task,
    output: error,
    success: false,
    error,
    durationMs,
    toolCalls,
    usage: emptyUsage(),
  };
}

function emptyUsage(): DelegateResult["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

