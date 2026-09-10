import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryItem } from "../../../shared/protocol.ts";

const NATIVE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Stateless projection of one Claude native transcript. Hidden reasoning and image bytes are excluded. */
export function readClaudeTranscript(args: { dir: string; sessionId: string }): HistoryItem[] {
  if (!NATIVE_SESSION_ID.test(args.sessionId)) throw new Error("Invalid Claude native session id");
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const path = join(root, "projects", args.dir.replace(/[^a-zA-Z0-9]/g, "-"), `${args.sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: HistoryItem[] = [];
  const toolNames = new Map<string, string>();
  const strip = (text: string) => text.split("\n")
    .filter(line => !/^\[(Figma file |Current selection: )/.test(line)).join("\n").trim();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; } // interrupted writes can leave a partial trailing line
    const record = object(parsed);
    const message = object(record?.message);
    const content = message?.content;
    const messageId = typeof message?.id === "string" ? message.id : undefined;
    if (record?.type === "user" && !record.isMeta) {
      if (typeof content === "string") out.push({ role: "user", text: strip(content) });
      for (const blockValue of Array.isArray(content) ? content : []) {
        const block = object(blockValue);
        if (block?.type === "text" && typeof block.text === "string") {
          if (/^\[Request interrupted/.test(block.text)) out.push({ role: "tool", name: "stopped", input: {} });
          else {
            const text = strip(block.text);
            if (text) out.push({ role: "user", text });
          }
        } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string"
          && toolNames.get(block.tool_use_id) === "mcp__figma__ask_user") {
          const values = Array.isArray(block.content) ? block.content : [];
          const answer = typeof block.content === "string" ? block.content
            : values.map(value => object(value)?.text ?? "").join("");
          out.push({ role: "answer", text: strip(String(answer)) });
        }
      }
    }
    if (record?.type === "assistant") for (const [index, blockValue] of (Array.isArray(content) ? content : []).entries()) {
      const block = object(blockValue);
      const itemId = messageId ? `${args.sessionId}:${messageId}:${index}` : undefined;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ role: "assistant", text: block.text, ...(itemId ? { itemId } : {}) });
      }
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolNames.set(block.id, block.name);
        out.push({ role: "tool", name: block.name, input: object(block.input) ?? {}, itemId: block.id });
      }
    }
  }
  return out;
}
