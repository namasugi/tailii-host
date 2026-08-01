// dirLister.ts
// tailii (TS host) — baseDir 配下限定のディレクトリ列挙/作成 + 非限定ブラウズ
// Swift 版 DirLister.swift の移植（session-workdir 4.x/5.x, dir-create, dir-picker 1.1）。

import * as fs from "node:fs";
import * as path from "node:path";
import { isInsideBase, standardize } from "../shared/paths.js";

export type DirCreateError =
  | "invalid_path"
  | "permission_denied"
  | "read_only"
  | "parent_not_found"
  | "parent_not_directory"
  | "already_exists"
  | "create_failed";

export interface DirCreateResult {
  path: string;
  ok: boolean;
  error?: DirCreateError;
}

/** `candidate` が `base` 自身または配下かを、パス成分境界込みで判定する。 */
function isContainedPath(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * target までの既存祖先を realpath で辿り、base の実体外へ出る symlink があるかを返す。
 * 最初の不存在成分以降には既存祖先が無いため、その時点で安全側の検査は完了する。
 */
function existingAncestorEscapesBase(base: string, target: string): boolean {
  const canonicalBase = fs.realpathSync.native(base);
  const relative = path.relative(base, target);
  let cursor = base;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const canonicalCursor = fs.realpathSync.native(cursor);
      if (!isContainedPath(canonicalCursor, canonicalBase)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

/** `baseDir/<partial の親>` 直下のサブディレクトリ名を prefix 一致で返す（base 外・不正は空）。 */
export function dirList(baseDir: string, partial: string): string[] {
  if (!baseDir) return [];
  // 絶対/`~` 直接指定は base 外（サジェスト対象外, 5.3/5.4）。
  if (partial.startsWith("/") || partial.startsWith("~")) return [];

  // partial を親と未完セグメント（prefix）へ分割する。
  const slashIdx = partial.lastIndexOf("/");
  const parent = slashIdx >= 0 ? partial.slice(0, slashIdx) : "";
  const prefix = slashIdx >= 0 ? partial.slice(slashIdx + 1) : partial;

  // baseDir/<parent> を正準化し、base 内側であることを確認する（`..` 脱出を拒否, 5.3）。
  const base = standardize(baseDir);
  const parentPath = standardize(parent === "" ? base : base + "/" + parent);
  if (!isInsideBase(parentPath, base)) return [];

  let names: string[];
  try {
    names = fs.readdirSync(parentPath);
  } catch {
    return [];
  }

  // 隠し dir は prefix が `.` 始まりのときのみ含める（4.7）。
  const includeHidden = prefix.startsWith(".");
  const result: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") && !includeHidden) continue;
    if (!name.startsWith(prefix)) continue;
    try {
      if (!fs.statSync(path.join(parentPath, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    result.push(name);
  }
  return result.sort();
}

/** ディレクトリが、現在の host プロセス権限で子ディレクトリを作成できる状態かを返す。 */
export function dirCanCreate(absolutePath: string): boolean {
  if (!absolutePath) return false;
  try {
    const dir = standardize(absolutePath);
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `baseDir` 配下限定で `relative` ディレクトリを作成する（base 外・不正・失敗は ok=false）。 */
export function dirCreate(baseDir: string, relative: string): DirCreateResult {
  if (!baseDir) return { path: "", ok: false, error: "invalid_path" };
  if (relative.startsWith("/")) {
    return { path: "", ok: false, error: "invalid_path" };
  }
  const trimmed = relative.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return { path: "", ok: false, error: "invalid_path" };
  }

  const base = standardize(baseDir);
  const target = standardize(base + "/" + trimmed);
  // base 内側（かつ base 自体でない）のみ許可（`..` 脱出を拒否）。
  if (target === base || !isContainedPath(target, base)) {
    return { path: target, ok: false, error: "invalid_path" };
  }

  try {
    const baseStat = fs.statSync(base);
    if (!baseStat.isDirectory()) {
      return { path: target, ok: false, error: "parent_not_directory" };
    }
    fs.accessSync(base, fs.constants.W_OK | fs.constants.X_OK);
    // 字句上 base 配下でも、既存 symlink が実体として base 外を指す場合は拒否する。
    if (existingAncestorEscapesBase(base, target)) {
      return { path: target, ok: false, error: "invalid_path" };
    }
    fs.mkdirSync(target, { recursive: true });
    return { path: target, ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "EACCES":
      case "EPERM":
        return { path: target, ok: false, error: "permission_denied" };
      case "EROFS":
        return { path: target, ok: false, error: "read_only" };
      case "ENOENT":
        return { path: target, ok: false, error: "parent_not_found" };
      case "ENOTDIR":
        return { path: target, ok: false, error: "parent_not_directory" };
      case "EEXIST":
        return { path: target, ok: false, error: "already_exists" };
      default:
        return { path: target, ok: false, error: "create_failed" };
    }
  }
}

/** 絶対パス直下のサブディレクトリ名を非限定で列挙する（隠し dir とファイルは除外、ソート済み）。 */
export function dirChildren(absolutePath: string): string[] {
  if (!absolutePath) return [];
  const dir = standardize(absolutePath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      if (!fs.statSync(path.join(dir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    result.push(name);
  }
  return result.sort();
}
