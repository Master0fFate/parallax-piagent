import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./state.js";
import type { ParallaxConfig, Strictness } from "./types.js";

const STRICTNESS = new Set<Strictness>(["strict", "standard", "relaxed"]);

export async function loadConfig(cwd: string, projectTrusted: boolean): Promise<ParallaxConfig> {
  if (!projectTrusted) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(await readFile(join(cwd, ".parallax", "config.json"), "utf8")) as Record<string, unknown>;
    const strictness = typeof raw.strictness === "string" && STRICTNESS.has(raw.strictness as Strictness)
      ? raw.strictness as Strictness
      : DEFAULT_CONFIG.strictness;
    const minScore = integerWithin(raw.minScore, 0, 100, DEFAULT_CONFIG.minScore);
    const maxRetries = integerWithin(raw.maxRetries, 1, 10, DEFAULT_CONFIG.maxRetries);
    const verificationTimeoutMs = integerWithin(
      raw.verificationTimeoutMs,
      1_000,
      900_000,
      DEFAULT_CONFIG.verificationTimeoutMs,
    );
    const verifyCommand = typeof raw.verifyCommand === "string" && raw.verifyCommand.trim()
      ? raw.verifyCommand.trim()
      : undefined;

    return {
      strictness,
      adaptiveProtocol: typeof raw.adaptiveProtocol === "boolean"
        ? raw.adaptiveProtocol
        : DEFAULT_CONFIG.adaptiveProtocol,
      autoActivateOnMutation: typeof raw.autoActivateOnMutation === "boolean"
        ? raw.autoActivateOnMutation
        : DEFAULT_CONFIG.autoActivateOnMutation,
      autoVerify: typeof raw.autoVerify === "boolean" ? raw.autoVerify : DEFAULT_CONFIG.autoVerify,
      designDocRequired: typeof raw.designDocRequired === "boolean"
        ? raw.designDocRequired
        : DEFAULT_CONFIG.designDocRequired,
      minScore,
      maxRetries,
      verificationTimeoutMs,
      trivialPatterns: stringArray(raw.trivialPatterns, DEFAULT_CONFIG.trivialPatterns),
      highRiskPatterns: stringArray(raw.highRiskPatterns, DEFAULT_CONFIG.highRiskPatterns),
      ...(verifyCommand ? { verifyCommand } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function integerWithin(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
