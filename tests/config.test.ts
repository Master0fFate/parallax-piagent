import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parallax-config-"));
  dirs.push(dir);
  await mkdir(join(dir, ".parallax"), { recursive: true });
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("trusted configuration", () => {
  it("ignores project configuration before trust", async () => {
    const dir = await temp();
    await writeFile(join(dir, ".parallax", "config.json"), JSON.stringify({ strictness: "relaxed", verifyCommand: "dangerous" }));
    const config = await loadConfig(dir, false);
    expect(config.strictness).toBe("standard");
    expect(config.autoActivateOnMutation).toBe(true);
    expect(config.verifyCommand).toBeUndefined();
  });

  it("validates bounded values and string patterns", async () => {
    const dir = await temp();
    await writeFile(join(dir, ".parallax", "config.json"), JSON.stringify({
      strictness: "strict",
      autoActivateOnMutation: false,
      minScore: 85,
      maxRetries: 999,
      trivialPatterns: ["*.json", 42],
      highRiskPatterns: [],
    }));
    const config = await loadConfig(dir, true);
    expect(config.strictness).toBe("strict");
    expect(config.autoActivateOnMutation).toBe(false);
    expect(config.minScore).toBe(85);
    expect(config.maxRetries).toBe(3);
    expect(config.trivialPatterns).toEqual(["*.json"]);
    expect(config.highRiskPatterns).toEqual([]);
  });
});
