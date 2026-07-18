import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  if (scripts.check) return [{ command: runner, args: runArgs(runner, "check"), label: `${runner} run check` }];

  const commands: VerifyCommand[] = [];
  for (const script of ["typecheck", "test", "lint"] as const) {
    const body = scripts[script];
    if (!body || (script === "test" && /no test specified/i.test(body))) continue;
    commands.push({ command: runner, args: runArgs(runner, script), label: `${runner} run ${script}` });
  }
  if (commands.length === 0 && scripts.build) {
    commands.push({ command: runner, args: runArgs(runner, "build"), label: `${runner} run build` });
  }
  return commands;
}

async function packageRunner(cwd: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(join(cwd, "bun.lock")) || await exists(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function runArgs(runner: string, script: string): string[] {
  return runner === "yarn" ? [script] : ["run", script];
}

function shellCommand(command: string): VerifyCommand {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/d", "/s", "/c", command], label: command }
    : { command: "sh", args: ["-c", command], label: command };
}

export async function runVerification(
  pi: ExtensionAPI,
  cwd: string,
  config: ParallaxConfig,
  files: string[],
  thorough: boolean,
  signal?: AbortSignal,
): Promise<VerificationRecord> {
  const detected = config.verifyCommand ? [shellCommand(config.verifyCommand)] : await detectVerifyCommands(cwd);
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
  let exitCode = 0;
  for (const item of commands) {
    try {
      const result = await pi.exec(item.command, item.args, {
        cwd,
        timeout: config.verificationTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      output.push(`$ ${item.label}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim());
      exitCode = result.code ?? -1;
      if (exitCode !== 0 || result.killed) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      exitCode = -1;
      output.push(`$ ${item.label}\nVerification command could not run: ${String(error)}`);
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
    command: commands.map((item) => item.label).join(" && "),
    files,
    verdict: exitCode === 0 ? "pass" : "fail",
    exitCode,
    durationMs: Date.now() - started,
    output: truncated || (exitCode === 0 ? "Verification passed." : "Verification failed without output."),
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

