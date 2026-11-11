// apiAgent/sessionState.ts
// 開いている API 作業の会話の記録（`~/.tailii/api-agent/sessions/<セッション名>.json`, 0600）。
//
// hub が開いたときに書き、終了（kill）で消す。engine の一覧（ApiAgentBackend.list）はこれを「生存」として読み、
// hub は再起動後にここから会話を待機状態で戻す。キーの値は書かない（取得元の種類・パス・変数名だけ）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApiAgentConfig } from "../protocol/messages.js";
import { validateSessionName } from "../sessions/sessionMetadataStore.js";
import { parseApiAgentConfig } from "./config.js";
import { isConversationUuid } from "./workerProtocol.js";

export interface ApiAgentSessionRecord {
  name: string;
  conversationId: string;
  cwd: string;
  config: ApiAgentConfig;
  openedAt: number;
}

export function defaultApiAgentSessionsDir(home: string = os.homedir()): string {
  return path.join(home, ".tailii", "api-agent", "sessions");
}

export class ApiAgentSessionStore {
  constructor(readonly directory: string = defaultApiAgentSessionsDir()) {}

  private fileFor(name: string): string {
    validateSessionName(name);
    return path.join(this.directory, `${name}.json`);
  }

  put(record: ApiAgentSessionRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, this.fileFor(record.name));
  }

  get(name: string): ApiAgentSessionRecord | null {
    try {
      return decodeRecord(JSON.parse(fs.readFileSync(this.fileFor(name), "utf8")) as unknown);
    } catch {
      return null;
    }
  }

  remove(name: string): void {
    try { fs.unlinkSync(this.fileFor(name)); } catch { /* 既に無い。 */ }
  }

  all(): ApiAgentSessionRecord[] {
    let entries: string[];
    try { entries = fs.readdirSync(this.directory); } catch { return []; }
    const out: ApiAgentSessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const record = this.get(entry.slice(0, -5));
      if (record !== null) out.push(record);
    }
    return out;
  }
}

function decodeRecord(raw: unknown): ApiAgentSessionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const config = parseApiAgentConfig(obj["config"]);
  if (typeof obj["name"] !== "string" || typeof obj["conversationId"] !== "string" || !isConversationUuid(obj["conversationId"]) ||
    typeof obj["cwd"] !== "string" || typeof obj["openedAt"] !== "number" || config === null) return null;
  return { name: obj["name"], conversationId: obj["conversationId"], cwd: obj["cwd"], config, openedAt: obj["openedAt"] };
}
