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

  it("blocks command substitution", () => {
    expect(isReadOnlyShellCommand("echo $(custom-script)")).toBe(false);
    expect(isReadOnlyShellCommand("echo `custom-script`")).toBe(false);
  });

  it("distinguishes verification from source mutation", () => {
    expect(classifyShellCommand("npm run check")).toBe("verification");
    expect(classifyShellCommand("cargo test --all-targets")).toBe("verification");
    expect(classifyShellCommand("eslint --fix src")).toBe("mutation");
    expect(classifyShellCommand("node -e \"require('fs').writeFileSync('x','y')\"")).toBe("mutation");
    expect(classifyShellCommand("find . -delete")).toBe("mutation");
  });
});
