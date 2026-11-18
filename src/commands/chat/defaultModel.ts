// commands/chat/defaultModel.ts
// `tailii-host chat models` が「今の既定のモデル」の印を付けるために、利用者の設定を読む（tailii-chat-cli）。
//
// Claude Code / Codex の優先順位を全部は再実装しない。読むのは主な層だけで、ほかの仕組みが効いていそうなとき・読めない形の
// ときは「決められない」（印なし）に倒す。誤った印で Bot が既定を取り違えるより、印が無い方がよい。
// 読み方を確かめた版: Claude Code 2.1.327 / Codex 0.170.0。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClaudeDefaultModelSetting } from "../../services/claudeModelCatalog.js";

/** 既定を読む場所（テストで差し替える）。 */
export interface DefaultModelContext {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Claude Code の管理者設定の置き場。 */
  claudeManagedDir: string;
  /** Codex の設定の置き場（App Server と同じ）。 */
  codexHome: string;
  /** Codex の管理者設定のファイル。 */
  codexManagedConfig: string;
}

export function defaultModelContext(): DefaultModelContext {
  const override = process.env["TAILII_CODEX_APP_SERVER_HOME"];
  return {
    home: os.homedir(),
    env: process.env,
    claudeManagedDir: process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code",
    codexHome: override !== undefined && override.length > 0 ? override : path.join(os.homedir(), ".codex"),
    codexManagedConfig: "/etc/codex/managed_config.toml",
  };
}

/** 既定の解決の結果。`id` は一覧の行の id、決められなければ null。`reason` はテストと調査用（出力には載せない）。 */
export interface DefaultModelResolution {
  id: string | null;
  reason: string;
}

interface ModelRow {
  id: string;
  displayName: string;
}

const none = (reason: string): DefaultModelResolution => ({ id: null, reason: `none:${reason}` });

type JsonLayer = { kind: "absent" } | { kind: "bad" } | { kind: "ok"; value: Record<string, unknown> };

function readJsonLayer(file: string): JsonLayer {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "bad" };
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { kind: "ok", value: value as Record<string, unknown> }
      : { kind: "bad" };
  } catch {
    return { kind: "bad" };
  }
}

function envBlock(layer: Record<string, unknown>): Record<string, unknown> {
  const env = layer["env"];
  return typeof env === "object" && env !== null ? env as Record<string, unknown> : {};
}

/** cwd から上へ、最初に `.git` がある祖先。無ければ null。 */
function gitAncestor(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `settings.local.json` を読むフォルダ（cwd と git の根。worktree は本体の根）。 */
function claudeLocalDirs(cwd: string): string[] {
  const dirs = [cwd];
  const ancestor = gitAncestor(cwd);
  if (ancestor === null) return dirs;
  let root: string | null = ancestor;
  try {
    if (fs.statSync(path.join(ancestor, ".git")).isFile()) {
      const match = /^gitdir:\s*(.+?)[/\\]\.git[/\\]worktrees[/\\][^/\\]+\s*$/.exec(fs.readFileSync(path.join(ancestor, ".git"), "utf8"));
      root = match?.[1] !== undefined ? path.resolve(ancestor, match[1]) : null;
    }
  } catch {
    root = null;
  }
  if (root !== null && !dirs.includes(root)) dirs.push(root);
  return dirs;
}

const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

/** 設定の値を一覧の行へ写す。 */
function claudeRowFor(
  value: string,
  rows: readonly ModelRow[],
  familyOverride: (family: string) => boolean,
): DefaultModelResolution {
  const bare = value.trim().replace(/\[[^\]]*\]$/, "").toLowerCase();
  const exact = rows.find((row) => row.id.toLowerCase() === bare);
  if (exact !== undefined) return { id: exact.id, reason: "exact" };
  if (!CLAUDE_FAMILIES.includes(bare)) return none("not_in_list");
  if (familyOverride(bare)) return none("family_override");
  const family = rows.find((row) => row.displayName.toLowerCase().includes(bare));
  return family !== undefined ? { id: family.id, reason: "family" } : none("not_in_list");
}

/** Claude の既定のモデル（`cwd` が null ならフォルダの設定を重ねない利用者の既定）。 */
export function resolveClaudeDefaultModel(
  rows: readonly ModelRow[],
  cwd: string | null,
  context: DefaultModelContext = defaultModelContext(),
): DefaultModelResolution {
  if ((context.env["CLAUDE_CONFIG_DIR"]?.length ?? 0) > 0) return none("config_dir");
  const managedFile = path.join(context.claudeManagedDir, "managed-settings.json");
  const userFile = path.join(context.home, ".claude", "settings.json");
  const managed = readJsonLayer(managedFile);
  const user = readJsonLayer(userFile);
  const project: JsonLayer = cwd === null ? { kind: "absent" } : readJsonLayer(path.join(cwd, ".claude", "settings.json"));
  const locals = cwd === null ? [] : claudeLocalDirs(cwd).map((dir) => readJsonLayer(path.join(dir, ".claude", "settings.local.json")));
  const all = [managed, user, project, ...locals];
  if (all.some((layer) => layer.kind === "bad")) return none("unreadable");
  const values = (layers: JsonLayer[]): Record<string, unknown>[] =>
    layers.flatMap((layer) => layer.kind === "ok" ? [layer.value] : []);
  const every = values(all);
  if (fs.existsSync(path.join(context.claudeManagedDir, "managed-settings.d"))) return none("managed_dropins");
  if (every.some((layer) => "availableModels" in layer || "enforceAvailableModels" in layer)) return none("model_restrictions");

  const claudeJson = readJsonLayer(path.join(context.home, ".claude.json"));
  const claudeJsonValue = claudeJson.kind === "ok" ? claudeJson.value : {};
  const hasEnv = (name: string, layers: Record<string, unknown>[]): boolean =>
    layers.some((layer) => name in envBlock(layer));
  if ((context.env["ANTHROPIC_MODEL"]?.length ?? 0) > 0 || hasEnv("ANTHROPIC_MODEL", [...every, claudeJsonValue])) return none("env_model");
  if (hasEnv("ANTHROPIC_DEFAULT_MODEL", values([managed, project, ...locals]))) return none("scoped_default_env");
  if ((claudeJsonValue["orgModelDefaultCache"] ?? null) !== null) return none("org_default");

  const familyOverride = (family: string): boolean => {
    const name = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
    return (context.env[name]?.length ?? 0) > 0 || hasEnv(name, every);
  };
  // 高い順。同じ順位の local が 2 か所で食い違うときは、どちらが勝つか確かめていないので決めない。
  const localValues = values(locals).filter((layer) => "model" in layer).map((layer) => layer["model"]);
  if (new Set(localValues).size > 1) return none("local_conflict");
  const ordered: { name: string; present: boolean; value: unknown }[] = [
    { name: "managed", present: managed.kind === "ok" && "model" in managed.value, value: managed.kind === "ok" ? managed.value["model"] : undefined },
    { name: "local", present: localValues.length > 0, value: localValues[0] },
    { name: "project", present: project.kind === "ok" && "model" in project.value, value: project.kind === "ok" ? project.value["model"] : undefined },
    { name: "user", present: user.kind === "ok" && "model" in user.value, value: user.kind === "ok" ? user.value["model"] : undefined },
  ];
  if (ordered.some((layer) => layer.present && typeof layer.value !== "string")) return none("model_not_string");
  const winner = ordered.find((layer) => layer.present);
  if (winner !== undefined) {
    const row = claudeRowFor(winner.value as string, rows, familyOverride);
    return row.id !== null ? { id: row.id, reason: winner.name } : row;
  }
  // 環境と user の `env` が食い違うと、起動の経路でどちらが勝つかが変わる。
  const processDefault = context.env["ANTHROPIC_DEFAULT_MODEL"]?.trim() ?? "";
  const userDefault = user.kind === "ok" ? envBlock(user.value)["ANTHROPIC_DEFAULT_MODEL"] : undefined;
  if (processDefault.length > 0 && userDefault !== undefined && userDefault !== processDefault) return none("default_env_conflict");
  const fromEnv = readClaudeDefaultModelSetting(context.env, userFile);
  if (fromEnv === null) return none("not_configured");
  const row = claudeRowFor(fromEnv, rows, familyOverride);
  return row.id !== null ? { id: row.id, reason: "env_default" } : row;
}

interface TomlTopLevel {
  model?: string;
  profile?: string;
}

/** 値の 1 行を読み、括弧の深さを返す。文字列の中の括弧と `#` は数えない。文字列が行の中で閉じない・括弧が合わないときは null。 */
function tomlDepthAfter(value: string, start: number): number | null {
  let depth = start;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote !== null) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "#") {
      break;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0) return null;
    }
  }
  return quote === null ? depth : null;
}

/** TOML の最上位の `model` / `profile` だけを読む。読めない形は null（呼び出し側は印なしに倒す）。 */
export function readTomlTopLevel(text: string): TomlTopLevel | null {
  const out: TomlTopLevel = {};
  let depth = 0; // 複数行の配列の中なら 1 以上。
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes('"""') || line.includes("'''")) return null;
    if (depth > 0) {
      const next = tomlDepthAfter(line, depth);
      if (next === null) return null;
      depth = next;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("[")) return out; // 最初のテーブルの見出しから先は最上位ではない。
    const assignment = /^("?'?)(model|profile)\1\s*=\s*(.*)$/.exec(line);
    if (assignment !== null) {
      if (assignment[1] !== "") return null;
      const key = assignment[2] as "model" | "profile";
      const value = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(assignment[3]!) ?? /^'([^']*)'\s*(?:#.*)?$/.exec(assignment[3]!);
      if (value === null || out[key] !== undefined) return null;
      out[key] = value[1]!;
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) return null;
    const next = tomlDepthAfter(line.slice(equals + 1), 0);
    if (next === null) return null;
    depth = next;
  }
  return depth === 0 ? out : null;
}

/** Codex の既定のモデル（`cwd` が null ならフォルダの設定を重ねない利用者の既定）。 */
export function resolveCodexDefaultModel(
  rows: readonly ModelRow[],
  cwd: string | null,
  context: DefaultModelContext = defaultModelContext(),
): DefaultModelResolution {
  if (fs.existsSync(context.codexManagedConfig)) return none("managed_config");
  const userFile = path.join(context.codexHome, "config.toml");
  let text: string;
  try {
    text = fs.readFileSync(userFile, "utf8");
  } catch {
    return none("no_config");
  }
  const top = readTomlTopLevel(text);
  if (top === null) return none("unreadable");
  if (top.profile !== undefined) return none("profile");
  if (top.model === undefined) return none("not_configured");
  if (cwd !== null) {
    const stop = gitAncestor(cwd) ?? cwd;
    let dir = cwd;
    for (;;) {
      const file = path.join(dir, ".codex", "config.toml");
      if (file !== userFile && fs.existsSync(file)) {
        let project: TomlTopLevel | null;
        try {
          project = readTomlTopLevel(fs.readFileSync(file, "utf8"));
        } catch {
          project = null;
        }
        if (project === null || project.model !== undefined || project.profile !== undefined) return none("project_config");
      }
      if (dir === stop) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const row = rows.find((entry) => entry.id === top.model);
  return row !== undefined ? { id: row.id, reason: "config" } : none("not_in_list");
}
