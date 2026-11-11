// apiAgent/exclusivity.ts
// 同じ会話 id を端末側（Tailii の pane・Tailii 外の端末・Remote Control）と API 作業で同時に動かさない。
//
// Claude Code は生きている間 `~/.claude/sessions/<pid>.json` に会話 id を登録する（conversationDelete.ts と
// 同じ登録簿。Tailii の pane 内の claude も載る）。ターンを始める直前にこれを照合し、会話を掴んでいる
// 生存プロセスがあれば断る。自分の作業プロセスが起動した claude（SDK の子）は除く。

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPeerSessionsDir } from "../services/peerSessions.js";

export interface ConversationHolder { pid: number; name: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function conversationHolders(
  conversationId: string,
  options: { dir?: string; isPidAlive?: (pid: number) => boolean; excludePids?: ReadonlySet<number> } = {},
): ConversationHolder[] {
  const dir = options.dir ?? defaultPeerSessionsDir();
  const alive = options.isPidAlive ?? pidAlive;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const holders: ConversationHolder[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")); } catch { continue; }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const pid = record["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (record["sessionId"] !== conversationId) continue;
    if (options.excludePids?.has(pid) === true || !alive(pid)) continue;
    holders.push({ pid, name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : `pid ${pid}` });
  }
  return holders;
}
