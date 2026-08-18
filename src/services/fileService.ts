// fileService.ts
// tailii (TS host) — cwd ファイルブラウザの一覧・プレビューサービス

import * as fs from "node:fs";
import * as path from "node:path";
import {
  IMAGE_EXTENSIONS,
  sipsThumbnailer,
  type Thumbnailer,
} from "../chat/imageService.js";
import type { FileEntry, FileFetchChunk, FileReadResult } from "../protocol.js";

const FILE_LIST_LIMIT = 1_000;
/** file_fetch の 1 チャンク生バイト数（base64 後 ≒ 88 KiB/行）。 */
export const FILE_FETCH_CHUNK_SIZE = 64 * 1024;
/** file_fetch で配信する原本サイズの上限。iPhone 側の保存先・回線を考え 512 MiB。 */
export const FILE_FETCH_SIZE_LIMIT = 512 * 1024 * 1024;
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

/** file_fetch 用の MIME 推定（拡張子ベース、未知は octet-stream）。 */
const FETCH_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
};

export function fetchMimeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return FETCH_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/**
 * ファイル原本を `file_fetch_response` のチャンク列として順に yield する（file-download）。
 *
 * - 不正パス・非ファイル・上限超過・読取失敗は `error` 付き単一チャンク（eof:true）。
 * - 空ファイルでも 1 チャンク（data 空・eof:true）を返す。
 * - 読み取り中に `isCancelled()` が true になったら以降を打ち切る（呼び出し側の中止要求）。
 * - 読み取り中にサイズが変わっても、開始時点の size ぶんだけを配る（増分は次回）。
 */
export async function* fileFetch(
  filePath: string,
  options: { chunkSize?: number; sizeLimit?: number; isCancelled?: () => boolean } = {},
): AsyncGenerator<FileFetchChunk> {
  const chunkSize = options.chunkSize ?? FILE_FETCH_CHUNK_SIZE;
  const sizeLimit = options.sizeLimit ?? FILE_FETCH_SIZE_LIMIT;
  const isCancelled = options.isCancelled ?? ((): boolean => false);

  if (!isAbsolutePath(filePath)) {
    yield fetchError("絶対パスを指定してください。");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    yield fetchError(String(error));
    return;
  }
  if (!stat.isFile()) {
    yield fetchError("ファイルではありません。");
    return;
  }
  if (stat.size > sizeLimit) {
    yield fetchError(`サイズ上限（${Math.floor(sizeLimit / (1024 * 1024))} MiB）を超えています。`);
    return;
  }

  const common = { mime: fetchMimeForPath(filePath), name: path.basename(filePath), size: stat.size };
  if (stat.size === 0) {
    yield { ...common, seq: 0, data: "", eof: true };
    return;
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch (error) {
    yield fetchError(String(error));
    return;
  }
  try {
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    let seq = 0;
    while (offset < stat.size) {
      if (isCancelled()) return;
      const length = Math.min(chunkSize, stat.size - offset);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, offset));
      } catch (error) {
        yield fetchError(String(error));
        return;
      }
      if (bytesRead <= 0) {
        // 開始時より縮んだ: 残りを届けられないので失敗として明示する。
        yield fetchError("読み取り中にファイルが変更されました。");
        return;
      }
      offset += bytesRead;
      yield {
        ...common,
        seq,
        data: buffer.subarray(0, bytesRead).toString("base64"),
        eof: offset >= stat.size,
      };
      seq += 1;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function fetchError(error: string): FileFetchChunk {
  return { seq: 0, data: "", eof: true, error };
}
