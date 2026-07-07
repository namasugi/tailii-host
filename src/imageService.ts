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
import { PROTOCOL_V1, type ControlMessage } from "./protocol.js";
import { ensureDirectory0700 } from "./paths.js";

/** サムネ生成結果（サムネ画像 base64 + 原寸）。base64 は HEIC（環境非対応時は PNG）。 */
export interface ThumbnailResult {
  /**
   * サムネ画像のバイト列（base64）。既定は HEIC（PNG の約半分・アルファ保持・iOS ネイティブ
   * デコード）、HEIC 書出し不能な環境では PNG にフォールバック。iOS 側は `UIImage(data:)` が
   * 形式を自動判定するため、どちらでも復号できる。
   */
  thumbnailBase64: string;
  width: number;
  height: number;
}

/** サムネ生成の注入可能な抽象。読めない/画像でない場合は null。 */
export type Thumbnailer = (imagePath: string, maxPixelSize: number) => Promise<ThumbnailResult | null>;

/** 原本 fetch の分割チャンクサイズ（生バイト, ≈32KiB）。base64 化前の生バイトで数える。 */
const FETCH_CHUNK_SIZE = 32 * 1024;

/** 画像として扱う拡張子集合（小文字・ドットなし）。 */
const IMAGE_EXTENSIONS = new Set([
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
    const attempt = async (format: "heic" | "png"): Promise<string | null> => {
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
        return fs.readFileSync(tmp).toString("base64");
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

    const base64 = (await attempt("heic")) ?? (await attempt("png"));
    if (base64 === null) return null;
    return { thumbnailBase64: base64, width, height };
  };
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

  constructor(options: {
    pendingBase?: string;
    indexBase?: string;
    thumbnailMaxPixelSize?: number;
    thumbnailer?: Thumbnailer;
  } = {}) {
    const home = os.homedir();
    this.pendingBase = options.pendingBase ?? path.join(home, ".tailii", "images", "pending");
    this.indexBase = options.indexBase ?? path.join(home, ".tailii", "images", "index");
    // サムネ最大辺（px）。インライン表示は 120pt 枠なので粗めで十分。WebP と併せて転送量を抑える。
    this.thumbnailMaxPixelSize = options.thumbnailMaxPixelSize ?? 160;
    this.thumbnailer = options.thumbnailer ?? sipsThumbnailer();
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
   * index に無い / 原本消失 / 読み取り不可 → `error(image_not_found)` を単一要素で返す。
   */
  fetch(id: string): ControlMessage[] {
    const p = this.readIndexPath(id);
    if (p === null) return [notFound(id)];

    let data: Buffer;
    try {
      data = fs.readFileSync(p);
    } catch {
      return [notFound(id)];
    }

    const mime = mimeTypeForExtension(path.extname(p).slice(1));
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

  /**
   * 指定パスから直接 `image_available` を生成する（pending 非経由・chat 添付用）。
   * 生成成功時は id→path を index に記録する。不存在・非画像は null（ベストエフォート）。
   */
  async makeAvailable(imagePath: string, imageId: string): Promise<ControlMessage | null> {
    const message = await this.generate(imageId, imagePath, null);
    return message.type === "image_available" ? message : null;
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

    // サムネ生成 + 原寸取得。読み取り不可 / 画像でない → not_an_image
    const thumb = await this.thumbnailer(imagePath, this.thumbnailMaxPixelSize);
    if (thumb === null) {
      return { type: "error", v: PROTOCOL_V1, id: imageId, code: "not_an_image", message: "画像として読み取れません" };
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
