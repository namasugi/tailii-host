import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DelegateError, type ClaudeApiDelegateRequest } from "./claudeApiDelegate.js";

type ContentBlock = { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; title: string; source: { type: "base64"; media_type: "application/pdf"; data: string } };
const MAX_BYTES = 20_000_000;
const MAX_IMAGE_BYTES = 5_000_000;

/** 会話入力欄で選択された uploads 内のファイルだけを読み、API の content blocks にする。 */
export async function loadDelegateAttachments(
  request: Pick<ClaudeApiDelegateRequest, "prompt" | "context" | "attachments">, signal: AbortSignal,
  directory = join(homedir(), ".tailii", "uploads"),
  budget = { totalBytes: 0, textBytes: 0 },
  maxImageBytes = MAX_IMAGE_BYTES,
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  budget.textBytes += Buffer.byteLength(request.prompt) + Buffer.byteLength(request.context);
  if (budget.textBytes > 120_000) throw new DelegateError("request_too_large");
  let root: string | undefined;
  for (const attachment of request.attachments ?? []) {
    signal.throwIfAborted();
    let data: Buffer;
    try {
      root ??= await realpath(directory);
      if (!isAbsolute(attachment.path)) throw new Error("path");
      const path = await realpath(attachment.path);
      if (dirname(path) !== root) throw new Error("path");
      // symlink の差し替えや FIFO を読まない。成長中のファイルにも読み出し上限を置く。
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("file");
        if (stat.size > MAX_BYTES - budget.totalBytes) throw new DelegateError("attachments_too_large");
        const limit = Math.min(stat.size + 1, MAX_BYTES - budget.totalBytes + 1);
        const buffer = Buffer.alloc(limit);
        let size = 0;
        while (size < limit) {
          signal.throwIfAborted();
          const read = await file.read(buffer, size, limit - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > stat.size || size > MAX_BYTES - budget.totalBytes) throw new DelegateError("attachments_too_large");
        if (size !== stat.size) throw new DelegateError("attachment_unavailable");
        data = buffer.subarray(0, size);
      } finally { await file.close(); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DelegateError) throw error;
      throw new DelegateError("attachment_unavailable");
    }
    budget.totalBytes += data.length;
    signal.throwIfAborted();
    const mime = imageMime(data);
    if (mime) {
      if (data.length > maxImageBytes) throw new DelegateError("attachments_too_large");
      content.push({ type: "text", text: `添付画像: ${attachment.name}` },
        { type: "image", source: { type: "base64", media_type: mime, data: data.toString("base64") } });
    } else if (data.subarray(0, 5).toString("ascii") === "%PDF-") {
      content.push({ type: "document", title: attachment.name,
        source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } });
    } else {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new DelegateError("unsupported_attachment"); }
      if (!text.trim() || /[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw new DelegateError("unsupported_attachment");
      budget.textBytes += data.length;
      if (budget.textBytes > 120_000) throw new DelegateError("request_too_large");
      content.push({ type: "text", text: `<reference_material name=${JSON.stringify(attachment.name)}>\n${text}\n</reference_material>` });
    }
  }
  if (request.context) content.push({ type: "text", text: `<reference_material>\n${request.context}\n</reference_material>` });
  content.push({ type: "text", text: request.prompt });
  return content;
}

function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
