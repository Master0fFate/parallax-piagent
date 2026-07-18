const MUTATING_PATTERNS = [
  /(^|[;&|]\s*)rm\b/i,
  /(^|[;&|]\s*)(mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd)\b/i,
  /(^|[^<])>{1,2}(?!&)/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|publish|link)\b/i,
  /\bfind\b[^\n]*(?:-delete|-exec|-execdir)\b/i,
  /\b(?:sed|perl)\s+[^\n]*-[^\s]*i\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
  /\b(sudo|kill|pkill|killall|reboot|shutdown)\b/i,
  /\$\(|`|[\r\n]/,
];

const READ_ONLY_PREFIXES = [
  "cat", "head", "tail", "less", "more", "grep", "rg", "find", "fd", "ls", "pwd", "echo", "printf",
  "wc", "sort", "uniq", "diff", "file", "stat", "du", "df", "tree", "which", "where", "whereis", "type",
  "env", "printenv", "uname", "whoami", "id", "date", "ps", "git status", "git log", "git diff", "git show",
  "git branch", "git remote", "npm list", "npm view", "npm info", "npm outdated", "node --version", "python --version",
  "python3 --version", "jq", "sed -n", "awk",
];

export type ShellCommandKind = "read-only" | "verification" | "mutation";

export function classifyShellCommand(command: string): ShellCommandKind {
  if (MUTATING_PATTERNS.some((pattern) => pattern.test(command))) return "mutation";
  const segments = splitCommands(command);
  if (segments.length > 0 && segments.every(isReadOnlySegment)) return "read-only";
  if (segments.length > 0 && segments.every(isVerificationSegment)) return "verification";
  return "mutation";
}

export function isReadOnlyShellCommand(command: string): boolean {
  return classifyShellCommand(command) === "read-only";
}

function splitCommands(command: string): string[] {
  return command
    .replace(/\|\|/g, ";")
    .split(/&&|[;|]/)
    .map((segment) => segment.trim().replace(/^\([^)]*\)\s*/, ""))
    .filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
  const value = segment.toLowerCase();
  return READ_ONLY_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
}

function isVerificationSegment(segment: string): boolean {
  const value = segment.toLowerCase();
  if (/\s--fix(?:\s|$)/.test(value) || /\s--write(?:\s|$)/.test(value)) return false;
  return [
    /^(npm|pnpm|yarn|bun)(?:\s+run)?\s+(check|test|typecheck|lint|build)(?:\s|$)/,
    /^cargo\s+(check|test|clippy)(?:\s|$)/,
    /^go\s+test(?:\s|$)/,
    /^(python|python3)\s+-m\s+(pytest|compileall)(?:\s|$)/,
    /^(pytest|vitest|jest|eslint|tsc)(?:\s|$)/,
    /^dotnet\s+(test|build)(?:\s|$)/,
  ].some((pattern) => pattern.test(value));
}
