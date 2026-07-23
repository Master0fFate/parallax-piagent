import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../bin/parallax-pi.mjs", import.meta.url));
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

async function writePassingTrace(cwd: string, id = "trace-1"): Promise<void> {
  const dir = join(cwd, ".parallax", "traces");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    schemaVersion: "2.0",
    sessionId: id,
    cwd,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    phases: ["ambiguity", "invariants", "gate", "commit", "summary"].map((step) => ({ step, detail: "evidence" })),
    verifications: [{ verdict: "pass" }],
  }));
}

describe("Parallax CLI", () => {
  it("initializes project configuration without overwriting it", async () => {
    const cwd = await temp();
    expect(run(cwd, "init").status).toBe(0);
    const second = run(cwd, "init");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Initialized");
    expect((await stat(join(cwd, ".parallax", "agents"))).isDirectory()).toBe(true);
  });

  it("lists, scores, and gates traces", async () => {
    const cwd = await temp();
    await writePassingTrace(cwd);
    expect(run(cwd, "trace", "list").stdout).toContain("trace-1");
    expect(run(cwd, "trace", "score", "trace-1").stdout).toContain("90/100");
    const gate = run(cwd, "gate", "--session", "trace-1", "--min-score", "80");
    expect(gate.status).toBe(0);
    expect(gate.stdout).toContain("PASS");
  });

  it("returns failure for incomplete compliance", async () => {
    const cwd = await temp();
    const dir = join(cwd, ".parallax", "traces");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "partial.json"), JSON.stringify({ phases: [{ step: "ambiguity" }], verifications: [] }));
    const result = run(cwd, "trace", "compliance", "partial");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[FAIL] invariants");
  });

  it("skips pre-commit when no trace exists", async () => {
    const result = run(await temp(), "pre-commit");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });
});
