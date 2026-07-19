import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "./text.js";
import type { ParallaxConfig, VerificationRecord } from "./types.js";

export interface VerifyCommand {
  command: string;
  args: string[];
  label: string;
}

const MAX_OUTPUT_BYTES = 50 * 1024;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectVerifyCommands(cwd: string): Promise<VerifyCommand[]> {
  if (await exists(join(cwd, "Cargo.toml"))) {
    return [
      { command: "cargo", args: ["check", "--all-targets", "--all-features"], label: "cargo check" },
      { command: "cargo", args: ["test", "--all-targets", "--all-features"], label: "cargo test" },
    ];
  }
  if (await exists(join(cwd, "go.mod"))) {
    return [{ command: "go", args: ["test", "./..."], label: "go test" }];
  }
  if (await exists(join(cwd, "package.json"))) {
    return detectNodeCommands(cwd);
  }
  if (await exists(join(cwd, "pyproject.toml")) || await exists(join(cwd, "requirements.txt"))) {
    const commands: VerifyCommand[] = [{
      command: process.platform === "win32" ? "python" : "python3",
      args: ["-m", "compileall", "-q", "-x", String.raw`(^|[\\/])(\.venv|venv|node_modules|\.git)([\\/]|$)`, "."],
      label: "python compileall",
    }];
    try {
      const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf8");
      if (/\bpytest\b/i.test(pyproject)) {
        commands.push({ command: process.platform === "win32" ? "python" : "python3", args: ["-m", "pytest"], label: "pytest" });
      }
    } catch {
      // requirements-only projects still get compileall.
    }
    return commands;
  }
  if (await exists(join(cwd, "Directory.Build.props")) || (await directoryContains(cwd, ".sln"))) {
    return [{ command: "dotnet", args: ["test", "--nologo"], label: "dotnet test" }];
  }
  return [];
}

async function directoryContains(cwd: string, suffix: string): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  try {
    return (await readdir(cwd)).some((entry) => entry.endsWith(suffix));
  } catch {
    return false;
  }
}

async function detectNodeCommands(cwd: string): Promise<VerifyCommand[]> {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const runner = await packageRunner(cwd);
  if (scripts.check) return [packageCommand(runner, "check")];

  const commands: VerifyCommand[] = [];
  for (const script of ["typecheck", "test", "lint"] as const) {
    const body = scripts[script];
    if (!body || (script === "test" && /no test specified/i.test(body))) continue;
    commands.push(packageCommand(runner, script));
  }
  if (commands.length === 0 && scripts.build) {
    commands.push(packageCommand(runner, "build"));
  }
  return commands;
}

async function packageRunner(cwd: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(join(cwd, "bun.lock")) || await exists(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function packageCommand(runner: "pnpm" | "yarn" | "bun" | "npm", script: string): VerifyCommand {
  const args = runner === "yarn" ? [script] : ["run", script];
  return { command: runner, args, label: `${runner} ${args.join(" ")}` };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatVerifyCommand(command: VerifyCommand): string {
  return [command.command, ...command.args].map(quoteShellArg).join(" ");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Verification cancelled.");
}

export async function runVerification(
  cwd: string,
  config: ParallaxConfig,
  files: string[],
  thorough: boolean,
  signal?: AbortSignal,
  operations: BashOperations = createLocalBashOperations(),
): Promise<VerificationRecord> {
  throwIfAborted(signal);
  const detected = config.verifyCommand
    ? [{ command: config.verifyCommand, args: [], label: config.verifyCommand }]
    : await detectVerifyCommands(cwd);
  const commands = thorough ? detected : detected.slice(0, 1);
  const started = Date.now();

  if (commands.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      command: null,
      files,
      verdict: "skipped",
      exitCode: null,
      durationMs: Date.now() - started,
      output: "No supported verification command detected. Set .parallax/config.json verifyCommand to configure one.",
    };
  }

  const output: string[] = [];
  const executed: string[] = [];
  let exitCode = 0;
  for (const item of commands) {
    throwIfAborted(signal);
    const remainingMs = config.verificationTimeoutMs - (Date.now() - started);
    if (remainingMs <= 0) {
      exitCode = -1;
      output.push(`$ ${item.label}\nVerification timed out before this command could run.`);
      break;
    }

    const chunks: Buffer[] = [];
    executed.push(item.label);
    try {
      const result = await operations.exec(
        config.verifyCommand ? item.command : formatVerifyCommand(item),
        cwd,
        {
          onData: (data) => chunks.push(Buffer.from(data)),
          ...(signal ? { signal } : {}),
          timeout: remainingMs / 1000,
        },
      );
      throwIfAborted(signal);
      const commandOutput = Buffer.concat(chunks).toString("utf8").trim();
      output.push(`$ ${item.label}${commandOutput ? `\n${commandOutput}` : ""}`);
      exitCode = result.exitCode ?? -1;
      if (exitCode !== 0) break;
    } catch (error) {
      throwIfAborted(signal);
      exitCode = -1;
      const commandOutput = Buffer.concat(chunks).toString("utf8").trim();
      output.push(`$ ${item.label}${commandOutput ? `\n${commandOutput}` : ""}\nVerification command could not complete: ${String(error)}`);
      break;
    }
  }

  const completeOutput = output.join("\n\n");
  const truncated = truncateUtf8(completeOutput, { maxBytes: MAX_OUTPUT_BYTES, keep: "tail" });
  let fullOutputPath: string | undefined;
  if (truncated !== completeOutput) {
    const dir = join(cwd, ".parallax", "verification");
    await mkdir(dir, { recursive: true });
    fullOutputPath = join(dir, `${Date.now()}.log`);
    await writeFile(fullOutputPath, completeOutput, "utf8");
  }

  return {
    timestamp: new Date().toISOString(),
    command: executed.join(" && "),
    files,
    verdict: exitCode === 0 ? "pass" : "fail",
    exitCode,
    durationMs: Date.now() - started,
    output: truncated || (exitCode === 0 ? "Verification passed." : "Verification failed without output."),
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}
