// hookSettings.ts
// tailii (TS host) — Claude 起動時に渡す承認フック設定と、旧 Codex hook の移行用管理。
// claude 側はファイル（settings.json）へは書かず、`claude --settings '<json>'` でこの起動プロセス
// 限定にフックを渡す（後述 claudeHookLaunchSettings 参照）。Codex App Server 経路は承認を
// JSON-RPC で受けるため hook を使わず、旧版 Tailii が登録した Codex hook は起動時に除去する。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Claude Code フックの外部タイムアウト（秒）。
 * hook の内部デッドラインより厳密に大きい値（内部 540 < OS 600）。
 */
export const HOOK_EXTERNAL_TIMEOUT_SECONDS = 600;

/**
 * claude 起動時に `--settings` へ渡す承認フック設定を JSON 文字列で返す。
 *
 * 以前は `<dir>/.claude/settings.json` に PreToolUse+PostToolUse フックを書き込んでいたが、
 * その方式だと「同じ dir で tailii を経由せず起動した通常の claude」までフックを拾ってしまい、
 * 承認ブローカーが居ないまま全ツール呼び出しがゲート待ちでハングする（＝リポジトリを開くと
 * バグる）。tmux で起動する claude プロセスにだけフックを効かせるため、ファイルには書かず
 * `claude --settings '<json>'` で渡す。これならリポジトリの settings.json を汚さず、
 * その一発の起動にだけフックが乗る。
 *
 * 無効化マーカー（`~/.tailii/nohook` かグローバル注入パス / `<dir>/.tailii-nohook`）が
 * あれば `null` を返す（フック無しで起動する）。
 */
export function claudeHookLaunchSettings(options: {
  dir: string;
  binaryPath: string;
  session: string;
  /** グローバル無効化マーカーのパス（注入可能）。省略時は `~/.tailii/nohook`。 */
  globalMarkerPath?: string;
}): string | null {
  const { dir, binaryPath, session } = options;

  // グローバル無効化: `~/.tailii/nohook` があれば全ディレクトリでフックを付与しない。
  const globalMarker =
    options.globalMarkerPath ?? path.join(os.homedir(), ".tailii", "nohook");
  if (fs.existsSync(globalMarker)) {
    process.stderr.write(
      "tailii: ~/.tailii/nohook を検出、承認フック付与を全ディレクトリでスキップ\n",
    );
    return null;
  }

  // 開発用エスケープハッチ: `.tailii-nohook` マーカーがある dir にはフックを付与しない。
  if (fs.existsSync(path.join(dir, ".tailii-nohook"))) {
    process.stderr.write(
      `tailii: .tailii-nohook を検出、承認フック付与をスキップ: ${dir}\n`,
    );
    return null;
  }

  // PreToolUse（ゲート）+ PostToolUse（監査）。イベントごとに独立した配列を生成する。
  const command = `${binaryPath} hook --session ${session}`;
  const entry = (): Record<string, unknown>[] => [
    {
      matcher: "*",
      hooks: [{ type: "command", command, timeout: HOOK_EXTERNAL_TIMEOUT_SECONDS }],
    },
  ];
  // UserPromptSubmit（処理開始）+ Stop（処理完了）: reaper daemon の「処理中は殺さない」判定用の
  // heartbeat 書込 + engine relay への一方向送信のみで即終了するため timeout は短くてよい。
  const lifecycleEntry = (): Record<string, unknown>[] => [
    { hooks: [{ type: "command", command, timeout: 30 }] },
  ];
  return JSON.stringify({
    hooks: {
      PreToolUse: entry(),
      PostToolUse: entry(),
      UserPromptSubmit: lifecycleEntry(),
      Stop: lifecycleEntry(),
    },
  });
}

/**
 * `<dir>/.codex/hooks.json` に codex（Codex CLI）用の PreToolUse フックを書き込む（既存ならマージ）。
 * codex はプロジェクトローカルの `.codex/hooks.json` を読み、Claude 互換スキーマ
 * （`{ "hooks": { "PreToolUse": [...] } }`）でフックを実行する。stdin/permissionDecision も互換だが、
 * codex は allow/ask を拒否し deny のみ有効なため、hook 側は `--agent codex` で allow を無出力にする。
 * codex はフック完了を同期ブロックで待つので、承認プッシュ待ちがそのままゲートになる。
 * command はセッション非依存の dispatcher 1 組だけにする。セッション名を command に埋め込むと、
 * 同一 cwd で会話を開くたびに全 command hook が累積・並列実行され、同じ承認が複数届くため。
 * 実セッションは Tailii 起動時に付ける `TAILII_SESSION` 環境変数から hook 側で解決する。
 * グローバル `~/.codex/hooks.json`（ユーザーの既存フック）には触れない（非侵襲）。
 */
export function installCodexHookSettings(options: {
  dir: string;
  binaryPath: string;
  /** グローバル無効化マーカーのパス（注入可能）。省略時は `~/.tailii/nohook`。 */
  globalMarkerPath?: string;
}): void {
  const { dir, binaryPath } = options;

  // グローバル/ローカル無効化マーカーは claude 版と共通。
  const globalMarker =
    options.globalMarkerPath ?? path.join(os.homedir(), ".tailii", "nohook");
  if (fs.existsSync(globalMarker)) {
    process.stderr.write(
      "tailii: ~/.tailii/nohook を検出、codex 承認フック書込を全ディレクトリでスキップ\n",
    );
    return;
  }
  if (fs.existsSync(path.join(dir, ".tailii-nohook"))) {
    process.stderr.write(
      `tailii: .tailii-nohook を検出、codex 承認フック書込をスキップ: ${dir}\n`,
    );
    return;
  }

  const codexDir = path.join(dir, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.mkdirSync(codexDir, { recursive: true });

  let root: Record<string, unknown> = {};
  if (fs.existsSync(hooksPath)) {
    const text = fs.readFileSync(hooksPath, "utf8");
    if (text.trim().length > 0) {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`既存 .codex/hooks.json が JSON オブジェクトとして解釈できない: ${hooksPath}`);
      }
      root = parsed as Record<string, unknown>;
    }
  }

  // 承認ゲート対象: シェル実行（Bash）とファイル編集（Write|Edit）。codex 実績のある matcher。
  const command = `${binaryPath} hook --agent codex`;
  const hooksObject =
    typeof root["hooks"] === "object" && root["hooks"] !== null && !Array.isArray(root["hooks"])
      ? (root["hooks"] as Record<string, unknown>)
      : {};
  const rawList = hooksObject["PreToolUse"];
  let list: Record<string, unknown>[] = Array.isArray(rawList)
    ? (rawList.filter((e) => typeof e === "object" && e !== null) as Record<string, unknown>[])
    : [];
  // Tailii 所有の旧/現行 command をすべて除去する。旧版は `--session <name>` を含むため、
  // 完全一致だけを消すとセッションごとに残り続ける。1 entry に他社 hook が混在する場合は
  // Tailii command だけを抜き、残りは保持する。
  list = list.flatMap((entry) => {
    const inner = entry["hooks"];
    if (!Array.isArray(inner)) return [entry];
    const remaining = inner.filter((hook) => !isTailiiCodexHook(hook, binaryPath));
    if (remaining.length === 0) return [];
    return [{ ...entry, hooks: remaining }];
  });
  for (const matcher of ["Bash", "Write|Edit"]) {
    list.push({
      matcher,
      hooks: [{ type: "command", command, timeout: HOOK_EXTERNAL_TIMEOUT_SECONDS }],
    });
  }
  hooksObject["PreToolUse"] = list;
  root["hooks"] = hooksObject;

  const out = JSON.stringify(sortKeysDeep(root), null, 2);
  const tmp = hooksPath + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, hooksPath);
}

/**
 * 旧版 Tailii が `<dir>/.codex/hooks.json` に追加した Codex hook だけを除去する。
 *
 * Codex App Server は承認要求を server-initiated JSON-RPC request として配信するため、
 * App Server 経路に PreToolUse hook を重ねると同じ承認が二重化する。無関係なユーザー hook は
 * event/entry 内で混在していても保持し、Tailii hook を除いた結果が空なら hooks.json 自体を消す。
 */
export function removeCodexHookSettings(options: {
  dir: string;
  binaryPath: string;
}): void {
  const hooksPath = path.join(options.dir, ".codex", "hooks.json");
  if (!fs.existsSync(hooksPath)) return;

  const text = fs.readFileSync(hooksPath, "utf8");
  if (text.trim().length === 0) return;
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`既存 .codex/hooks.json が JSON オブジェクトとして解釈できない: ${hooksPath}`);
  }
  const root = parsed as Record<string, unknown>;
  const rawHooks = root["hooks"];
  if (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks)) return;

  const hooksObject = rawHooks as Record<string, unknown>;
  for (const [event, rawEntries] of Object.entries(hooksObject)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries = rawEntries.flatMap((rawEntry): unknown[] => {
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        return [rawEntry];
      }
      const entry = rawEntry as Record<string, unknown>;
      const rawInner = entry["hooks"];
      if (!Array.isArray(rawInner)) return [entry];
      const remaining = rawInner.filter(
        (hook) => !isTailiiCodexHook(hook, options.binaryPath),
      );
      if (remaining.length === 0) return [];
      return [{ ...entry, hooks: remaining }];
    });
    if (entries.length === 0) delete hooksObject[event];
    else hooksObject[event] = entries;
  }

  if (Object.keys(hooksObject).length === 0) delete root["hooks"];
  else root["hooks"] = hooksObject;

  if (Object.keys(root).length === 0) {
    fs.rmSync(hooksPath);
    return;
  }
  const out = JSON.stringify(sortKeysDeep(root), null, 2);
  const tmp = hooksPath + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, hooksPath);
}

/** 指定 binary が登録した Codex hook か。旧 `--session` 形式もまとめて所有扱いする。 */
function isTailiiCodexHook(value: unknown, binaryPath: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const hookCommand = (value as Record<string, unknown>)["command"];
  if (typeof hookCommand !== "string") return false;
  return hookCommand.startsWith(`${binaryPath} hook `) && /(?:^|\s)--agent\s+codex(?:\s|$)/.test(hookCommand);
}

/** オブジェクトのキーを再帰的に辞書順へ並べ替える（Swift 版 .sortedKeys 相当）。 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
