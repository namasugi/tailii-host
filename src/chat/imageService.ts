// imageService.ts
// tailii (TS host) — 画像サムネ生成サービス（承認往復と非同期）
// Swift 版 ImageService.swift の移植。
// pending キュー（hook が投入）を drain し、低解像度サムネ（最大辺 256px, base64 inline）と
// 原寸 width/height を載せた `image_available` を生成する。id→原本 path を index に記録し、
// 原本のオンデマンド分割配信（fetch）の逆引きに用いる。
//
// Swift 版は ImageIO/CoreGraphics でサムネを作るが、Node には画像処理の標準が無いため
// macOS 標準の `sips` CLI を既定 thumbnailer とする（注入可能 — テスト/他OS は差し替え）。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_V1, type ControlMessage } from "../protocol.js";
import { ensureDirectory0700 } from "../shared/paths.js";

/** サムネ生成結果（サムネ画像 base64 + 原寸）。base64 は HEIC（環境非対応時は PNG）。 */
export interface ThumbnailResult {
  /**
   * サムネ画像のバイト列（base64）。既定は HEIC（PNG の約半分・アルファ保持・iOS ネイティブ
   * デコード）、HEIC 書出し不能な環境では PNG にフォールバック。iOS 側は `UIImage(data:)` が
   * 形式を自動判定するため、どちらでも復号できる。
   */
  thumbnailBase64: string;
  /** 実際に生成したサムネ形式。旧注入実装との互換のため省略可。 */
  imageFormat?: "heic" | "png";
  width: number;
  height: number;
}

/** サムネ生成の注入可能な抽象。読めない/画像でない場合は null。 */
export type Thumbnailer = (imagePath: string, maxPixelSize: number) => Promise<ThumbnailResult | null>;

type ImageAvailable = Extract<ControlMessage, { type: "image_available" }>;

/** 全画面表示用の縮小結果（image-fetch-display）。 */
export interface ResizedImage {
  data: Buffer;
  mime: string;
}

/**
 * 全画面表示用に長辺 `maxPixelSize` まで縮めた画像を作る注入可能な抽象。縮める必要が無い・
 * 縮められない（アニメーション GIF・変換失敗）ときは null（呼び出し側が原本を返す）。
 */
export type ImageResizer = (imagePath: string, maxPixelSize: number) => Promise<ResizedImage | null>;

/** 原本 fetch の分割チャンクサイズ（生バイト, ≈32KiB）。base64 化前の生バイトで数える。 */
const FETCH_CHUNK_SIZE = 32 * 1024;

/** 画像として扱う拡張子集合（小文字・ドットなし）。 */
export const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif",
]);

/** 拡張子 → mime（index に mime を持たないため拡張子起点）。 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
};

export function mimeTypeForExtension(ext: string): string {
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? "application/octet-stream";
}

/** macOS 標準 `sips` によるサムネ生成（既定 thumbnailer）。 */
export function sipsThumbnailer(sipsPath = "/usr/bin/sips"): Thumbnailer {
  const run = (args: string[]): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(sipsPath, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout) });
      });
    });

  return async (imagePath, maxPixelSize) => {
    // 原寸取得。sips は非画像に非0または空プロパティを返す。
    const probe = await run(["-g", "pixelWidth", "-g", "pixelHeight", imagePath]);
    if (probe.code !== 0) return null;
    const width = parseSipsProperty(probe.stdout, "pixelWidth");
    const height = parseSipsProperty(probe.stdout, "pixelHeight");
    if (width === null || height === null || width <= 0 || height <= 0) return null;

    // 最大辺 maxPixelSize のサムネを一時ファイルへ生成する。既定は HEIC（PNG の約半分・
    // アルファ保持）。sips が HEIC を書けない環境（write 非対応）では PNG へフォールバックする。
    // （macOS の sips は WebP を read 専用で write 不可のため HEIC を採用。）
    // 一時ファイルの拡張子は sips が出力フォーマット判定に使うため format と一致させる。
    const attempt = async (
      format: "heic" | "png",
    ): Promise<{ base64: string; format: "heic" | "png" } | null> => {
      const tmp = path.join(
        os.tmpdir(),
        `tailii-thumb-${process.pid}-${Math.random().toString(36).slice(2)}.${format}`,
      );
      try {
        const convert = await run([
          "-s", "format", format,
          "-Z", String(maxPixelSize),
          imagePath,
          "--out", tmp,
        ]);
        if (convert.code !== 0) return null;
        return { base64: fs.readFileSync(tmp).toString("base64"), format };
      } catch {
        return null;
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 一時ファイル掃除の失敗は無視。
        }
      }
    };

    const converted = (await attempt("heic")) ?? (await attempt("png"));
    if (converted === null) return null;
    return {
      thumbnailBase64: converted.base64,
      imageFormat: converted.format,
      width,
      height,
    };
  };
}

/**
 * macOS 標準 `sips` による全画面表示用の縮小（既定 resizer, image-fetch-display）。
 * 長辺が `maxPixelSize` を超えるものは縮め、形式は HEIC にする（PNG スクリーンショットで大きく効く）。
 * 長辺が収まっている JPEG / HEIC は原本のままで十分軽いので触らない。GIF はアニメーションが
 * 止まるので触らない。拡大はしない（`-Z` は小さい画像を引き伸ばすため、収まるときは付けない）。
 */
export function sipsResizer(sipsPath = "/usr/bin/sips", timeoutMs = 15_000): ImageResizer {
  // sips が固まっても応答を返せるよう打ち切る（打ち切りは失敗扱い = 原本へフォールバック）。
  const run = (args: string[]): Promise<number> =>
    new Promise((resolve) => {
      execFile(sipsPath, args, { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs }, (error) => {
        resolve(error ? (typeof error.code === "number" ? error.code : 1) : 0);
      });
    });
  const probe = (imagePath: string): Promise<{ width: number; height: number } | null> =>
    new Promise((resolve) => {
      execFile(sipsPath, ["-g", "pixelWidth", "-g", "pixelHeight", imagePath], { timeout: timeoutMs }, (error, stdout) => {
        if (error) return resolve(null);
        const width = parseSipsProperty(String(stdout), "pixelWidth");
        const height = parseSipsProperty(String(stdout), "pixelHeight");
        resolve(width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null);
      });
    });

  return async (imagePath, maxPixelSize) => {
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    if (ext === "gif") return null;
    const size = await probe(imagePath);
    if (size === null) return null;
    const fits = Math.max(size.width, size.height) <= maxPixelSize;
    if (fits && ["jpg", "jpeg", "heic", "heif"].includes(ext)) return null;

    const tmp = path.join(
      os.tmpdir(),
      `tailii-display-${process.pid}-${Math.random().toString(36).slice(2)}.heic`,
    );
    try {
      const args = ["-s", "format", "heic"];
      if (!fits) args.push("-Z", String(maxPixelSize));
      args.push(imagePath, "--out", tmp);
      if (await run(args) !== 0) return null;
      const data = fs.readFileSync(tmp);
      return data.length > 0 ? { data, mime: "image/heic" } : null;
    } catch {
      return null;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 一時ファイル掃除の失敗は無視。
      }
    }
  };
}

/** 画像バイト列を `image_fetch_response` の seq/eof 分割メッセージ列にする。 */
function chunkedFetchResponse(id: string, data: Buffer, mime: string): ControlMessage[] {
  if (data.length === 0) {
    // 空原本でも 1 チャンク（eof:true, data 空）を返す。
    return [{ type: "image_fetch_response", v: PROTOCOL_V1, id, seq: 0, data: "", eof: true, mime }];
  }
  const messages: ControlMessage[] = [];
  let offset = 0;
  let seq = 0;
  while (offset < data.length) {
    const end = Math.min(offset + FETCH_CHUNK_SIZE, data.length);
    messages.push({
      type: "image_fetch_response",
      v: PROTOCOL_V1,
      id,
      seq,
      data: data.subarray(offset, end).toString("base64"),
      eof: end === data.length,
      mime,
    });
    offset = end;
    seq += 1;
  }
  return messages;
}

function parseSipsProperty(stdout: string, name: string): number | null {
  const match = stdout.match(new RegExp(`${name}:\\s*(\\d+)`));
  if (!match || match[1] === undefined) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

/** 画像サムネの非同期生成（pending 消費 → image_available）と id→path index 記録。 */
export class ImageService {
  private readonly pendingBase: string;
  private readonly indexBase: string;
  private readonly thumbnailMaxPixelSize: number;
  private readonly thumbnailer: Thumbnailer;
  /**
   * サムネ生成結果のメモ（key = path + mtimeMs + size）。同一パスの再 Read を毎回発行する
   * ようになった（chat-image-reread）ため、replay で同じ未変更ファイルに sips を何十回も
   * 走らせない。ファイルが書き換われば mtime/size が変わり自然に再生成される。
   */
  private readonly thumbnailMemo = new Map<string, ThumbnailResult>();
  private static readonly THUMBNAIL_MEMO_LIMIT = 256;
  private readonly resizer: ImageResizer;
  /**
   * 全画面表示用の縮小結果のメモ（key = path + mtimeMs + size + maxPixelSize, image-fetch-display）。
   * 開き直しや別端末から同じ画像を開くたびに sips を走らせない。合計バイト数の上限を
   * 超えたら古いものから捨てる（挿入順 = LRU 順）。
   */
  private readonly displayMemo = new Map<string, ResizedImage>();
  private displayMemoBytes = 0;
  /** 縮小中の要求（同じ画像への同時要求で sips を二重に走らせない）。 */
  private readonly displayInFlight = new Map<string, Promise<ResizedImage | null>>();
  private static readonly DISPLAY_MEMO_BYTE_LIMIT = 64 * 1024 * 1024;

  constructor(options: {
    pendingBase?: string;
    indexBase?: string;
    thumbnailMaxPixelSize?: number;
    thumbnailer?: Thumbnailer;
    resizer?: ImageResizer;
  } = {}) {
    const home = os.homedir();
    this.pendingBase = options.pendingBase ?? path.join(home, ".tailii", "images", "pending");
    this.indexBase = options.indexBase ?? path.join(home, ".tailii", "images", "index");
    // サムネ最大辺（px）。インライン表示は 120pt 枠なので粗めで十分。WebP と併せて転送量を抑える。
    this.thumbnailMaxPixelSize = options.thumbnailMaxPixelSize ?? 160;
    this.thumbnailer = options.thumbnailer ?? sipsThumbnailer();
    this.resizer = options.resizer ?? sipsResizer();
  }

  /**
   * pending キューを drain し、各エントリを `image_available` または `error` に変換する。
   * 処理した pending エントリは（成功・失敗を問わず）キューから除去する。
   */
  async drainPending(): Promise<ControlMessage[]> {
    const entries = this.readPendingEntries();
    const results: ControlMessage[] = [];
    for (const entry of entries) {
      results.push(await this.generate(entry.imageId, entry.path, entry.relatedApprovalId));
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        // 除去失敗は無視（次回 drain で再走査されるが実害はない）。
      }
    }
    return results;
  }

  /**
   * `id` を index 逆引きし、原本を `image_fetch_response` の seq/eof 分割メッセージ列で返す。
   * `maxPixelSize` があれば全画面表示用に縮めたものを返す（縮めても軽くならなければ原本,
   * image-fetch-display）。
   * index に無い / 原本消失 / 読み取り不可 → `error(image_not_found)` を単一要素で返す。
   */
  async fetch(id: string, maxPixelSize?: number): Promise<ControlMessage[]> {
    const p = this.readIndexPath(id);
    if (p === null) return [notFound(id)];

    let data: Buffer;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
      data = fs.readFileSync(p);
    } catch {
      return [notFound(id)];
    }

    let mime = mimeTypeForExtension(path.extname(p).slice(1));
    if (maxPixelSize !== undefined && data.length > 0) {
      const resized = await this.displayImage(p, stat, maxPixelSize);
      if (resized !== null && resized.data.length < data.length) {
        data = resized.data;
        mime = resized.mime;
      }
    }
    return chunkedFetchResponse(id, data, mime);
  }

  /** 全画面表示用の縮小結果をメモ経由で得る（image-fetch-display）。 */
  private async displayImage(
    imagePath: string,
    stat: fs.Stats,
    maxPixelSize: number,
  ): Promise<ResizedImage | null> {
    const key = `${imagePath}\u0000${stat.mtimeMs}\u0000${stat.size}\u0000${maxPixelSize}`;
    const hit = this.displayMemo.get(key);
    if (hit !== undefined) {
      this.displayMemo.delete(key);
      this.displayMemo.set(key, hit);
      return hit;
    }
    const inFlight = this.displayInFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const pending = this.resizer(imagePath, maxPixelSize).catch(() => null);
    this.displayInFlight.set(key, pending);
    const resized = await pending;
    this.displayInFlight.delete(key);
    // 縮めなかった・縮められなかった（sips の失敗・打ち切りを含む）結果は覚えない。一時的な
    // 失敗でその画像がファイルが変わるまで原本で返り続けないようにする（判定は probe 1 回で安い）。
    if (resized === null) return null;
    this.displayMemo.set(key, resized);
    this.displayMemoBytes += resized.data.length;
    while (this.displayMemoBytes > ImageService.DISPLAY_MEMO_BYTE_LIMIT && this.displayMemo.size > 1) {
      const oldest = this.displayMemo.keys().next().value;
      if (oldest === undefined) break;
      this.displayMemoBytes -= this.displayMemo.get(oldest)?.data.length ?? 0;
      this.displayMemo.delete(oldest);
    }
    return resized;
  }

  /**
   * 指定パスから直接 `image_available` を生成する（pending 非経由・chat 添付用）。
   * 生成成功時は id→path を index に記録する。不存在・非画像は null（ベストエフォート）。
   */
  async makeAvailable(imagePath: string, imageId: string): Promise<ImageAvailable | null> {
    const message = await this.generate(imageId, imagePath, null);
    return message.type === "image_available" ? message : null;
  }

  /** Claude/Codex・履歴/live 共通。欠損画像があっても添付連番を詰めず、元発話へ紐づける。 */
  async makeAttachmentsAvailable(text: string, streamId: string): Promise<ImageAvailable[]> {
    const available: ImageAvailable[] = [];
    const paths = attachmentImagePaths(text);
    for (const [index, imagePath] of paths.entries()) {
      const image = await this.makeAvailable(imagePath, `att-${streamId}-${index}`);
      if (image !== null) available.push(image);
    }
    return available;
  }

  /** サムネ生成の中核（pending 経路と直接経路で共有）。 */
  private async generate(
    imageId: string,
    imagePath: string,
    relatedApprovalId: string | null,
  ): Promise<ControlMessage> {
    // 不存在（またはディレクトリ）→ image_not_found
    let stat: fs.Stats;
    try {
      stat = fs.statSync(imagePath);
    } catch {
      return { type: "error", v: PROTOCOL_V1, id: imageId, code: "image_not_found", message: "画像が見つかりません" };
    }
    if (stat.isDirectory()) {
      return { type: "error", v: PROTOCOL_V1, id: imageId, code: "image_not_found", message: "画像が見つかりません" };
    }

    // 拡張子が画像でない → not_an_image（読み取り可否確認前の早期判定）
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return { type: "error", v: PROTOCOL_V1, id: imageId, code: "not_an_image", message: "画像として扱えません" };
    }

    // サムネ生成 + 原寸取得。読み取り不可 / 画像でない → not_an_image。
    // 未変更ファイル（path + mtime + size 一致）はメモ命中で sips を再実行しない。
    const memoKey = `${imagePath}\u0000${stat.mtimeMs}\u0000${stat.size}`;
    let thumb = this.thumbnailMemo.get(memoKey) ?? null;
    if (thumb !== null) {
      // 命中エントリを末尾へ移して LRU 順を保つ。
      this.thumbnailMemo.delete(memoKey);
      this.thumbnailMemo.set(memoKey, thumb);
    } else {
      thumb = await this.thumbnailer(imagePath, this.thumbnailMaxPixelSize);
      if (thumb === null) {
        return { type: "error", v: PROTOCOL_V1, id: imageId, code: "not_an_image", message: "画像として読み取れません" };
      }
      this.thumbnailMemo.set(memoKey, thumb);
      if (this.thumbnailMemo.size > ImageService.THUMBNAIL_MEMO_LIMIT) {
        const oldest = this.thumbnailMemo.keys().next().value;
        if (oldest !== undefined) this.thumbnailMemo.delete(oldest);
      }
    }

    // 生成成功時のみ id→path を index に記録
    try {
      this.writeIndex(imageId, imagePath);
    } catch {
      // index 記録失敗は fetch 不能になるだけ（Swift 版 try? と同じ握り潰し）。
    }

    const message: ControlMessage = {
      type: "image_available",
      v: PROTOCOL_V1,
      id: imageId,
      path: imagePath,
      mime: mimeTypeForExtension(ext),
      thumbnail: thumb.thumbnailBase64,
      width: thumb.width,
      height: thumb.height,
    };
    if (relatedApprovalId !== null) {
      (message as { relatedApprovalId?: string }).relatedApprovalId = relatedApprovalId;
    }
    return message;
  }

  /** pending ベース配下の `*.json` を読み、妥当なエントリだけ返す（壊れたファイルは無視）。 */
  private readPendingEntries(): {
    filePath: string;
    imageId: string;
    path: string;
    relatedApprovalId: string | null;
  }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.pendingBase);
    } catch {
      return [];
    }
    const entries: { filePath: string; imageId: string; path: string; relatedApprovalId: string | null }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const filePath = path.join(this.pendingBase, name);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (typeof raw !== "object" || raw === null) continue;
        const rec = raw as Record<string, unknown>;
        if (typeof rec["imageId"] !== "string" || typeof rec["path"] !== "string") continue;
        entries.push({
          filePath,
          imageId: rec["imageId"],
          path: rec["path"],
          relatedApprovalId: typeof rec["relatedApprovalId"] === "string" ? rec["relatedApprovalId"] : null,
        });
      } catch {
        // 壊れたエントリは無視（対象外）。
      }
    }
    return entries;
  }

  /** index（`<indexBase>/<id>.json` = `{id, path}`）から原本 path を逆引きする。 */
  private readIndexPath(id: string): string | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.indexBase, `${id}.json`), "utf8"),
      ) as unknown;
      if (typeof raw !== "object" || raw === null) return null;
      const p = (raw as Record<string, unknown>)["path"];
      return typeof p === "string" ? p : null;
    } catch {
      return null;
    }
  }

  /** id→原本 path を `<indexBase>/<id>.json` へ記録する（fetch 逆引き用）。 */
  private writeIndex(id: string, imagePath: string): void {
    ensureDirectory0700(this.indexBase);
    const target = path.join(this.indexBase, `${id}.json`);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ id, path: imagePath }));
    fs.renameSync(tmp, target);
  }
}

function notFound(id: string): ControlMessage {
  return { type: "error", v: PROTOCOL_V1, id, code: "image_not_found", message: "画像が見つかりません" };
}

/** 添付パス抽出は Claude/Codex・履歴/live の各配信経路で共有する。 */
export function attachmentImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/@"(\/[^"]+)"/g)) {
    if (match[1] !== undefined) paths.push(match[1]);
  }
  for (const match of text.matchAll(/@(\/[^\s"]+)/g)) {
    if (match[1] !== undefined) paths.push(match[1]);
  }
  // MessageInputBar.composeOutgoing は upload 済みパスを @ なしで本文先頭へ置く。
  // ファイル名は iOS 側で安全な文字へ正規化済みなので、空白/引用符を境界に抽出できる。
  for (const match of text.matchAll(
    /(?:^|[\s"])(\/(?:[^\s"]*\/)?\.tailii\/uploads\/[^\s"]+)/g,
  )) {
    if (match[1] !== undefined) paths.push(match[1]);
  }
  const seen = new Set<string>();
  return paths.filter((p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return false;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}
