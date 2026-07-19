import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { detectVerifyCommands, formatVerifyCommand, runVerification } from "../src/verify.js";
import { DEFAULT_CONFIG } from "../src/state.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-verify-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function fakeOperations(
  execute: BashOperations["exec"],
): BashOperations {
  return { exec: execute };
}

describe("verification detection", () => {
  it("treats a check script as canonical", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc && vitest", test: "vitest" } }));
    expect(await detectVerifyCommands(dir)).toEqual([{ command: "npm", args: ["run", "check"], label: "npm run check" }]);
  });

  it("keeps package commands platform-neutral", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
    expect((await detectVerifyCommands(dir))[0]).toEqual({ command: "npm", args: ["run", "check"], label: "npm run check" });
  });

  it("uses lockfile package manager", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    expect((await detectVerifyCommands(dir)).map((item) => item.command)).toEqual(["pnpm", "pnpm"]);
  });

  it("quotes arguments for Pi's portable shell backend", () => {
    expect(formatVerifyCommand({ command: "tool", args: ["path with spaces", "it's-safe"], label: "tool" }))
      .toBe("'tool' 'path with spaces' 'it'\"'\"'s-safe'");
  });

  it("ignores npm's placeholder test", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo Error: no test specified && exit 1", lint: "eslint ." } }));
    expect((await detectVerifyCommands(dir)).map((item) => item.label)).toEqual(["npm run lint"]);
  });

  it("detects Rust", async () => {
    const dir = await temp();
    await writeFile(join(dir, "Cargo.toml"), "[package]");
    expect((await detectVerifyCommands(dir)).map((item) => item.label)).toEqual(["cargo check", "cargo test"]);
  });

  it("detects Go", async () => {
    const dir = await temp();
    await writeFile(join(dir, "go.mod"), "module test");
    expect((await detectVerifyCommands(dir))[0]?.label).toBe("go test");
  });

  it("returns no command for unknown projects", async () => {
    expect(await detectVerifyCommands(await temp())).toEqual([]);
  });
});

describe("verification execution", () => {
  it("passes only a completed zero exit and preserves output", async () => {
    const operations = fakeOperations(async (_command, _cwd, options) => {
      options.onData(Buffer.from("all checks passed\n"));
      return { exitCode: 0 };
    });
    const result = await runVerification(await temp(), { ...DEFAULT_CONFIG, verifyCommand: "universal-check" }, [], true, undefined, operations);
    expect(result).toMatchObject({ verdict: "pass", exitCode: 0, command: "universal-check" });
    expect(result.output).toContain("all checks passed");
  });

  it("propagates a real checker failure through Pi's local shell backend", async () => {
    const verifyCommand = formatVerifyCommand({
      command: process.execPath,
      args: ["-e", "console.error('checker failed'); process.exit(7)"],
      label: "node checker",
    });
    const result = await runVerification(await temp(), { ...DEFAULT_CONFIG, verifyCommand }, [], true);
    expect(result).toMatchObject({ verdict: "fail", exitCode: 7 });
    expect(result.output).toContain("checker failed");
  });

  it("fails on a nonzero exit and stops the command sequence", async () => {
    const dir = await temp();
    await writeFile(join(dir, "Cargo.toml"), "[package]");
    const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, options) => {
      options.onData(Buffer.from("compiler error\n"));
      return { exitCode: 2 };
    });
    const result = await runVerification(dir, DEFAULT_CONFIG, [], true, undefined, fakeOperations(exec));
    expect(result).toMatchObject({ verdict: "fail", exitCode: 2, command: "cargo check" });
    expect(result.output).toContain("compiler error");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("never treats a killed process as passing", async () => {
    const operations = fakeOperations(async () => ({ exitCode: null }));
    const result = await runVerification(await temp(), { ...DEFAULT_CONFIG, verifyCommand: "killed-check" }, [], true, undefined, operations);
    expect(result).toMatchObject({ verdict: "fail", exitCode: -1 });
  });

  it("records executor failures as verification failures", async () => {
    const operations = fakeOperations(async () => { throw new Error("missing executable"); });
    const result = await runVerification(await temp(), { ...DEFAULT_CONFIG, verifyCommand: "missing-check" }, [], true, undefined, operations);
    expect(result).toMatchObject({ verdict: "fail", exitCode: -1 });
    expect(result.output).toContain("missing executable");
  });

  it("propagates cancellation without launching a command", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const exec = vi.fn<BashOperations["exec"]>();
    await expect(runVerification(await temp(), DEFAULT_CONFIG, [], true, controller.signal, fakeOperations(exec)))
      .rejects.toThrow("user cancelled");
    expect(exec).not.toHaveBeenCalled();
  });

  it("applies one shrinking deadline across a verification run", async () => {
    const dir = await temp();
    await writeFile(join(dir, "Cargo.toml"), "[package]");
    const timeouts: number[] = [];
    const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, options) => {
      timeouts.push(options.timeout ?? 0);
      return { exitCode: 0 };
    });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_400).mockReturnValue(1_400);
    const result = await runVerification(dir, { ...DEFAULT_CONFIG, verificationTimeoutMs: 1_000 }, [], true, undefined, fakeOperations(exec));
    expect(result.verdict).toBe("pass");
    expect(timeouts[0]).toBeCloseTo(1);
    expect(timeouts[1]).toBeCloseTo(0.6);
  });
});
