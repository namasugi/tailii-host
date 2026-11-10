import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validClaudeApiKey } from "./claudeApiKey.js";

export type ApiKeyProvider = "claude" | "openai";
export function validDelegateApiKey(provider: ApiKeyProvider, key: string): boolean {
  if (key !== key.trim()) return false;
  if (provider === "claude") return validClaudeApiKey(key);
  return /^sk-[A-Za-z0-9_-]{20,4000}$/.test(key) && !["sk-ant-", "sk-admin-", "sk-orgadmin-"].some((prefix) => key.startsWith(prefix));
}
export class ApiDelegateKeyStore {
  constructor(readonly directory = join(homedir(), ".tailii", "api-keys")) {}
  load(provider: ApiKeyProvider): string | undefined {
    let fd: number | undefined;
    try {
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) return undefined;
      fd = openSync(join(this.directory, provider), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return undefined;
      const key = readFileSync(fd, "utf8");
      return validDelegateApiKey(provider, key) ? key : undefined;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  create(provider: ApiKeyProvider, key: string): void {
    if (!validDelegateApiKey(provider, key)) throw new Error("invalid_key");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("host_key_store_unavailable");
    const temporary = join(this.directory, "." + randomUUID());
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, key); fsyncSync(fd); closeSync(fd); fd = undefined;
      // 完成したファイルだけを公開し、既存キーを上書きしない。
      linkSync(temporary, join(this.directory, provider));
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* 作成前の失敗 */ }
    }
  }
}
export const apiDelegateKeyStore = new ApiDelegateKeyStore();
