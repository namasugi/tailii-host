// previewServer.ts
// tailii (TS host) — Web プレビュー用の loopback 静的ファイルサーバー。
//
// iOS の Web プレビューは既存 SSH 接続内の direct-tcpip トンネルで Mac の
// 127.0.0.1 へ到達する。dev サーバーはそのままトンネルで開けるが、
// ディスク上の HTML ファイルには配信元が必要なため、このサーバーが
// 「対象ファイルのディレクトリ」を root として loopback のみで配信する。
// ネットワークへは一切公開しない（bind は 127.0.0.1 固定）。
// URL には 128bit ランダムトークンのパス接頭辞を必須にする。

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/** open が失敗したときの型付きエラー。message はそのまま preview_error に載る。 */
export class PreviewError extends Error {
  constructor(
    public readonly reason: "invalid-target" | "not-found",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "PreviewError";
  }
}

interface StaticSite {
  server: http.Server;
  url: string;
  /** この site を参照しているプレビュー要求 id。空になったら畳む。 */
  ids: Set<string>;
  /** server が抱える生きた接続。close を即時にするため destroy する。 */
  sockets: Set<net.Socket>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const BIND_HOST = "127.0.0.1";

/** トークン cookie の名前接頭辞（`tailii_t_<token>=1`）。複数 site が同居しても衝突しない。 */
const COOKIE_PREFIX = "tailii_t_";

/**
 * `.html/.htm` の絶対パスを受け取り、そのディレクトリを root に配信する
 * loopback 静的サーバー群を管理する。同一ファイルの再 open はリスナーを
 * 再利用し、`close(id)` で参照が尽きたら teardown する。
 */
export class PreviewServer {
  /** normalized file path → site */
  private readonly sites = new Map<string, StaticSite>();
  /** preview 要求 id → normalized file path */
  private readonly idToKey = new Map<string, string>();

  /** target（.html/.htm 絶対パス）の配信を開始し、到達 URL を返す。 */
  async open(id: string, target: string): Promise<{ url: string }> {
    const key = this.validateTarget(target);
    await this.requireReadableFile(key);

    const existing = this.sites.get(key);
    if (existing) {
      existing.ids.add(id);
      this.idToKey.set(id, key);
      return { url: existing.url };
    }

    const rootDir = path.dirname(key);
    const token = randomBytes(16).toString("hex");
    const server = http.createServer((req, res) => {
      void this.handleRequest(rootDir, token, req, res);
    });
    const sockets = new Set<net.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, BIND_HOST, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("listen address unavailable"));
          return;
        }
        resolve(address.port);
      });
    });

    const url = `http://${BIND_HOST}:${port}/t/${token}/${encodeURIComponent(path.basename(key))}`;
    const site: StaticSite = { server, url, ids: new Set([id]), sockets };
    this.sites.set(key, site);
    this.idToKey.set(id, key);
    return { url };
  }

  /** id の参照を外し、最後の参照ならサーバーを畳む。未知 id は no-op。 */
  async close(id: string): Promise<void> {
    const key = this.idToKey.get(id);
    if (key === undefined) return;
    this.idToKey.delete(id);
    const site = this.sites.get(key);
    if (site === undefined) return;
    site.ids.delete(id);
    if (site.ids.size > 0) return;
    this.sites.delete(key);
    await PreviewServer.shutdown(site);
  }

  /** 全サーバーを畳む（engine 終了時）。冪等。 */
  async closeAll(): Promise<void> {
    const sites = [...this.sites.values()];
    this.sites.clear();
    this.idToKey.clear();
    await Promise.all(sites.map((site) => PreviewServer.shutdown(site)));
  }

  private validateTarget(target: string): string {
    const normalized = path.normalize(target);
    if (!path.isAbsolute(normalized)) {
      throw new PreviewError("invalid-target", `絶対パスではない: ${target}`);
    }
    const ext = path.extname(normalized).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") {
      throw new PreviewError("invalid-target", `.html/.htm ではない: ${target}`);
    }
    return normalized;
  }

  private async requireReadableFile(filePath: string): Promise<void> {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new PreviewError("not-found", filePath);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError("not-found", filePath);
    }
  }

  private async handleRequest(
    rootDir: string,
    token: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
      const prefix = `/t/${token}/`;

      if (rawPath.startsWith(prefix)) {
        // トークン付きパス: HTML のディレクトリ配下を配信する（相対参照の解決）。
        let decodedRel: string;
        try {
          decodedRel = decodeURIComponent(rawPath.slice(prefix.length));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const resolved = path.resolve(rootDir, decodedRel);
        if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
          res.writeHead(403).end();
          return;
        }
        // トークンを cookie にも載せる。HTML 内の**絶対パス参照**（<img src="/Users/..."> 等）は
        // トークン接頭辞を持たない URL になるため、後続要求はこの cookie で認可する。
        await PreviewServer.serveFile(resolved, res, {
          "set-cookie": `${COOKIE_PREFIX}${token}=1; Path=/; SameSite=Lax`,
        });
        return;
      }

      if (PreviewServer.hasTokenCookie(req, token)) {
        // 有効な cookie 持ちの絶対パス要求: HTML 内の絶対参照を解決する。
        // 認可主体はトークン保持者＝SSH トンネル越しの本人のみ（cookie は最初の
        // トークン付き応答でしか配られない）。root 制限は課さない（本人の Mac の
        // 本人が読めるファイルであり、エージェント生成 HTML は uploads 等
        // ディレクトリ外の絶対パスを普通に参照するため）。
        let decoded: string;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const resolved = path.normalize(decoded);
        if (!path.isAbsolute(resolved)) {
          res.writeHead(404).end();
          return;
        }
        await PreviewServer.serveFile(resolved, res);
        return;
      }

      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  /** ファイル 1 件を MIME 付きで応答する（ディレクトリは index.html へフォールバック）。 */
  private static async serveFile(
    requestedPath: string,
    res: http.ServerResponse,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    let filePath = requestedPath;
    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath).catch(() => null);
    }
    if (info === null || !info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "content-length": info.size, ...extraHeaders });
    const stream = createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  private static hasTokenCookie(req: http.IncomingMessage, token: string): boolean {
    const header = req.headers.cookie;
    if (header === undefined) return false;
    return header
      .split(";")
      .some((part) => part.trim().startsWith(`${COOKIE_PREFIX}${token}=`));
  }

  private static async shutdown(site: StaticSite): Promise<void> {
    for (const socket of site.sockets) socket.destroy();
    await new Promise<void>((resolve) => site.server.close(() => resolve()));
  }
}
