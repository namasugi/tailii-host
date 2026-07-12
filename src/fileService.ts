// fileService.ts
// tailii (TS host) — cwd ファイルブラウザの一覧・プレビューサービス

import * as fs from "node:fs";
import * as path from "node:path";
import {
  IMAGE_EXTENSIONS,
  sipsThumbnailer,
  type Thumbnailer,
} from "./imageService.js";
import type { FileEntry, FileReadResult } from "./protocol.js";

const FILE_LIST_LIMIT = 1_000;
const TEXT_PREVIEW_LIMIT = 256 * 1024;
const NON_IMAGE_SIZE_LIMIT = 5 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_PIXEL_SIZE = 1_024;

function isAbsolutePath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !candidate.startsWith("~");
}

/** ディレクトリを列挙する。不正パス・読取不能は空一覧で返す。 */
export function fileList(directoryPath: string): {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
} {
  if (!isAbsolutePath(directoryPath)) {
    return { path: directoryPath, entries: [], truncated: false };
  }

  let names: string[];
  try {
    names = fs.readdirSync(directoryPath);
  } catch {
    return { path: directoryPath, entries: [], truncated: false };
  }

  const entries: FileEntry[] = [];
  for (const name of names) {
    try {
      const stat = fs.lstatSync(path.join(directoryPath, name));
      const kind: FileEntry["kind"] = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "dir"
          : "file";
      entries.push({
        name,
        kind,
        size: kind === "dir" ? 0 : stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      });
    } catch {
      // 列挙後に消えたエントリは無視する。
    }
  }

  entries.sort((lhs, rhs) => {
    const lhsRank = lhs.kind === "dir" ? 0 : 1;
    const rhsRank = rhs.kind === "dir" ? 0 : 1;
    if (lhsRank !== rhsRank) return lhsRank - rhsRank;
    return lhs.name < rhs.name ? -1 : lhs.name > rhs.name ? 1 : 0;
  });
  return {
    path: directoryPath,
    entries: entries.slice(0, FILE_LIST_LIMIT),
    truncated: entries.length > FILE_LIST_LIMIT,
  };
}

/** ファイルをプレビュー用に読み取る。例外は kind=error の正常応答へ変換する。 */
export async function fileRead(
  filePath: string,
  thumbnailer: Thumbnailer = sipsThumbnailer(),
): Promise<FileReadResult> {
  if (!isAbsolutePath(filePath)) return fileError(filePath, "絶対パスを指定してください。");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return fileError(filePath, String(error));
  }
  if (!stat.isFile()) return fileError(filePath, "ファイルではありません。");

  const common = { path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    try {
      const thumbnail = await thumbnailer(filePath, IMAGE_PREVIEW_MAX_PIXEL_SIZE);
      if (thumbnail === null) return { ...common, kind: "error", error: "画像として読み取れません。" };
      return {
        ...common,
        kind: "image",
        imageBase64: thumbnail.thumbnailBase64,
        imageFormat: thumbnail.imageFormat ?? "heic",
      };
    } catch (error) {
      return { ...common, kind: "error", error: String(error) };
    }
  }

  if (stat.size > NON_IMAGE_SIZE_LIMIT) return { ...common, kind: "tooLarge" };

  let content: Buffer;
  try {
    const descriptor = fs.openSync(filePath, "r");
    try {
      const length = Math.min(stat.size, TEXT_PREVIEW_LIMIT);
      content = Buffer.alloc(length);
      const bytesRead = fs.readSync(descriptor, content, 0, length, 0);
      content = content.subarray(0, bytesRead);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return { ...common, kind: "error", error: String(error) };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return {
      ...common,
      kind: "text",
      content: text,
      truncated: stat.size > content.length,
    };
  } catch {
    return { ...common, kind: "binary" };
  }
}

function fileError(filePath: string, error: string): FileReadResult {
  return { path: filePath, kind: "error", size: 0, mtimeMs: 0, error };
}
