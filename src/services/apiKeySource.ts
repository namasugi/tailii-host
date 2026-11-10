import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiUsageCredential } from "../protocol/messages.js";

/** 指定した取得元だけを読む。失敗時に別のキーへ切り替えない。 */
export function resolveApiKeySource(source: ApiUsageCredential, env: NodeJS.ProcessEnv): string | undefined {
  if (source.mode === "custom") return source.apiKey?.trim(); // 旧クライアントとの通信互換のみ
  if (source.mode === "environment") {
    const name = source.environmentVariable;
    return name && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !/\s/.test(name) ? env[name]?.trim() : undefined;
  }
  if (source.mode !== "file" || !source.path || source.path.length > 4096 || /[\x00-\x1f]/.test(source.path)) return undefined;
  const path = source.path.startsWith("~/") ? join(homedir(), source.path.slice(2)) : source.path;
  if (!path.startsWith("/")) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 8192) return undefined;
    const buffer = Buffer.alloc(8193);
    let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    return size <= 8192 ? buffer.subarray(0, size).toString("utf8").trim() : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
