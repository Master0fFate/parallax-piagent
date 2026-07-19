import { describe, expect, it } from "vitest";
import { classifyShellCommand, isReadOnlyShellCommand } from "../src/readonly-shell.js";

describe("plan shell gate", () => {
  it.each(["ls -la", "rg TODO src", "git status", "git diff --stat", "cat package.json | jq .name"])("allows %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  it.each(["rm -rf dist", "echo x > file", "git checkout main", "npm install zod", "ls; touch x"])("blocks %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  it("fails closed for unknown commands and pipeline stages", () => {
    expect(isReadOnlyShellCommand("custom-script --dry-run")).toBe(false);
    expect(isReadOnlyShellCommand("cat package.json | custom-script")).toBe(false);
  });

  it("blocks command substitution and process substitution", () => {
    expect(isReadOnlyShellCommand("echo $(custom-script)")).toBe(false);
    expect(isReadOnlyShellCommand("echo `custom-script`")).toBe(false);
    expect(isReadOnlyShellCommand("cat <(touch x)")).toBe(false);
  });

  it("fails closed for utilities and flags that can execute or write", () => {
    expect(isReadOnlyShellCommand("env custom-script")).toBe(false);
    expect(isReadOnlyShellCommand("awk 'BEGIN { system(\"touch x\") }'")).toBe(false);
    expect(isReadOnlyShellCommand("find . -fprint output")).toBe(false);
    expect(isReadOnlyShellCommand("sed -n 'e touch x' file")).toBe(false);
    expect(isReadOnlyShellCommand("sort input -o output")).toBe(false);
    expect(isReadOnlyShellCommand("git diff --output=patch")).toBe(false);
    expect(isReadOnlyShellCommand("git show --textconv")).toBe(false);
    expect(isReadOnlyShellCommand("rg --pre custom-filter needle")).toBe(false);
  });

  it("distinguishes verification from source mutation", () => {
    expect(classifyShellCommand("npm run check")).toBe("verification");
    expect(classifyShellCommand("cargo test --all-targets")).toBe("verification");
    expect(classifyShellCommand("eslint --fix src")).toBe("mutation");
    expect(classifyShellCommand("node -e \"require('fs').writeFileSync('x','y')\"")).toBe("mutation");
    expect(classifyShellCommand("find . -delete")).toBe("mutation");
  });
});
