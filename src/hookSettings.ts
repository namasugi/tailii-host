// hookSettings.ts
// tailii (TS host) — claude 起動時に渡す承認フック設定の生成 + codex 用 .codex/hooks.json 書込。
// claude 側はファイル（settings.json）へは書かず、`claude --settings '<json>'` でこの起動プロセス
// 限定にフックを渡す（後述 claudeHookLaunchSettings 参照）。codex はプロジェクトローカルの
// .codex/hooks.json を読む仕様のため従来どおりマージ書込する。

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
  return JSON.stringify({ hooks: { PreToolUse: entry(), PostToolUse: entry() } });
}

/**
 * `<dir>/.codex/hooks.json` に codex（Codex CLI）用の PreToolUse フックを書き込む（既存ならマージ）。
 * codex はプロジェクトローカルの `.codex/hooks.json` を読み、Claude 互換スキーマ
 * （`{ "hooks": { "PreToolUse": [...] } }`）でフックを実行する。stdin/permissionDecision も互換だが、
 * codex は allow/ask を拒否し deny のみ有効なため、hook 側は `--agent codex` で allow を無出力にする。
 * codex はフック完了を同期ブロックで待つので、承認プッシュ待ちがそのままゲートになる。
 * グローバル `~/.codex/hooks.json`（ユーザーの既存フック）には触れない（非侵襲）。
 */
export function installCodexHookSettings(options: {
  dir: string;
  binaryPath: string;
  session: string;
  /** グローバル無効化マーカーのパス（注入可能）。省略時は `~/.tailii/nohook`。 */
  globalMarkerPath?: string;
}): void {
  const { dir, binaryPath, session } = options;

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
  const command = `${binaryPath} hook --session ${session} --agent codex`;
  const hooksObject =
    typeof root["hooks"] === "object" && root["hooks"] !== null && !Array.isArray(root["hooks"])
      ? (root["hooks"] as Record<string, unknown>)
      : {};
  const rawList = hooksObject["PreToolUse"];
  let list: Record<string, unknown>[] = Array.isArray(rawList)
    ? (rawList.filter((e) => typeof e === "object" && e !== null) as Record<string, unknown>[])
    : [];
  // 既存の同一 command を除去（再実行で重複しない）。
  list = list.filter((entry) => {
    const inner = entry["hooks"];
    if (!Array.isArray(inner)) return true;
    return !inner.some(
      (h) =>
        typeof h === "object" &&
        h !== null &&
        (h as Record<string, unknown>)["command"] === command,
    );
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
