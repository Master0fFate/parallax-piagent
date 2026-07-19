import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectVerifyCommands, runVerification } from "../src/verify.js";
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
});

describe("verification detection", () => {
  it("treats a check script as canonical", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc && vitest", test: "vitest" } }));
    expect((await detectVerifyCommands(dir)).map((item) => item.label)).toEqual(["npm run check"]);
  });

  it("uses a platform-runnable npm command", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
    const command = (await detectVerifyCommands(dir))[0]!;
    expect(command.command).toBe(process.platform === "win32" ? "cmd" : "npm");
    expect(command.args).toEqual(process.platform === "win32" ? ["/d", "/s", "/c", "npm run check"] : ["run", "check"]);
  });

  it("uses lockfile package manager", async () => {
    const dir = await temp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const executable = process.platform === "win32" ? "cmd" : "pnpm";
    expect((await detectVerifyCommands(dir)).map((item) => item.command)).toEqual([executable, executable]);
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

  it("records command startup failures as verification failures", async () => {
    const dir = await temp();
    const pi = { exec: async () => { throw new Error("missing executable"); } } as unknown as ExtensionAPI;
    const result = await runVerification(pi, dir, { ...DEFAULT_CONFIG, verifyCommand: "missing-check" }, [], true);
    expect(result.verdict).toBe("fail");
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("missing executable");
  });
});
