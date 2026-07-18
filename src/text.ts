export const DEFAULT_OUTPUT_BYTES = 50 * 1024;

export function truncateUtf8(
  value: string,
  options: { maxBytes?: number; keep?: "head" | "tail"; note?: string } = {},
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_BYTES;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;

  if (options.keep === "tail") {
    let start = Math.max(0, value.length - maxBytes);
    while (Buffer.byteLength(value.slice(start), "utf8") > maxBytes) start += 1;
    const omitted = bytes - Buffer.byteLength(value.slice(start), "utf8");
    return `[Output truncated: ${omitted} leading bytes omitted.${options.note ? ` ${options.note}` : ""}]\n${value.slice(start)}`;
  }

  let end = Math.min(value.length, maxBytes);
  while (Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  const omitted = bytes - Buffer.byteLength(value.slice(0, end), "utf8");
  return `${value.slice(0, end)}\n[Output truncated: ${omitted} trailing bytes omitted.${options.note ? ` ${options.note}` : ""}]`;
}

export function stringifyForTool(value: unknown, note?: string): string {
  return truncateUtf8(JSON.stringify(value, null, 2), note ? { note } : {});
}
