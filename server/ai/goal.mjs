import fs from "node:fs";
import path from "node:path";
import { claudeHome } from "./agents.mjs";

/**
 * Goal mode: "/goal <condition>" keeps the agent working until the condition holds. Claude
 * checks it each time it would stop (an evaluator model) and writes every check into its own
 * conversation file (`goal_status` entries: what its CLI draws as "Goal not yet met…
 * continuing", "Goal achieved"); its ACP adapter does not pass them on, so the file is read as
 * it grows. Codex reports its goal through its adapter (patched to tell every client, see
 * patches/). Both come out as the same events, which change the goal the chat shows.
 */

// What Claude takes as "/goal clear".
const CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** "/goal …" as typed: what it asks for; null for any other message. */
export function goalCommand(text) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { action: "status" };
  const word = argument.toLowerCase();
  if (CLEAR.has(word)) return { action: "clear" };
  if (word === "pause" || word === "resume") return { action: word };
  return { action: "set", objective: argument };
}

/** Claude's file of a conversation: projects/<folder of its working directory>/<id>.jsonl. */
export function claudeTranscript(acpSessionId) {
  const root = path.join(claudeHome(), "projects");
  let folders;
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const file = path.join(root, folder.name, acpSessionId + ".jsonl");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** A `goal_status` entry as an event (sentinels mark a goal set, or ended without a check). */
export function goalEvent(status, at = Date.now()) {
  const objective = String(status.condition ?? "").trim();
  if (status.sentinel) return status.met ? { type: "cleared", objective, at } : { type: "set", objective, at };
  const reason = typeof status.reason === "string" ? status.reason.trim() : null;
  if (!status.met && !status.failed) return { type: "check", objective, at, reason };
  return { type: status.failed ? "failed" : "met", objective, at, reason, iterations: status.iterations, durationMs: status.durationMs, tokens: status.tokens };
}

/**
 * Claude's goal events as they are written: each `read()` returns those in what the file
 * gained since the last one (whole lines only). It starts at the file's end, or at its start
 * when the conversation has no file yet (everything in it will be new).
 */
export class ClaudeGoalReader {
  constructor(acpSessionId) {
    this.id = acpSessionId;
    this.file = claudeTranscript(acpSessionId);
    this.offset = this.file ? fs.statSync(this.file).size : 0;
    this.rest = "";
  }
  read() {
    this.file ??= claudeTranscript(this.id);
    if (!this.file) return [];
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      this.file = null;
      return [];
    }
    // Written anew (moved with its work): read it again from the start.
    if (size < this.offset) {
      this.offset = 0;
      this.rest = "";
    }
    if (size === this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const lines = (this.rest + buffer.toString("utf8")).split("\n");
    this.rest = lines.pop() ?? "";
    const events = [];
    for (const line of lines) {
      if (!line.includes('"goal_status"')) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type === "attachment" && row.attachment?.type === "goal_status") events.push(goalEvent(row.attachment, Date.parse(row.timestamp) || Date.now()));
    }
    return events;
  }
}

/** What Claude prints for a goal command (no message id: not the model's words), as an event. */
export function goalOutput(text) {
  const set = /^Goal set: ([\s\S]+)$/.exec(text);
  if (set) return { type: "set", objective: set[1].trim() };
  const cleared = /^Goal cleared: ([\s\S]+)$/.exec(text);
  if (cleared) return { type: "cleared", objective: cleared[1].trim() };
  if (/^No goal set\b/.test(text)) return { type: "none" };
  return null;
}

/**
 * Claude ends a turn whose stop hooks kept it going too many times in a row (8 by default;
 * a tool call starts the count anew) with a warning: with a goal, the goal's check said "not
 * met" each time the AI tried to stop. The number of times, or null for other notices.
 */
export function hookCap(text) {
  const match = /A hook blocked the turn from ending (\d+) consecutive times/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Codex's goal statuses as the adapter names them. */
export const CODEX_STATUSES = new Set(["active", "paused", "blocked", "limited", "complete"]);
