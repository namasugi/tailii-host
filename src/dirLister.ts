// dirLister.ts
// tailii (TS host) — baseDir 配下限定のディレクトリ列挙/作成 + 非限定ブラウズ
// Swift 版 DirLister.swift の移植（session-workdir 4.x/5.x, dir-create, dir-picker 1.1）。

import * as fs from "node:fs";
import * as path from "node:path";
import { isInsideBase, standardize } from "./paths.js";

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

/** `baseDir` 配下限定で `relative` ディレクトリを作成する（base 外・不正・失敗は ok=false）。 */
export function dirCreate(baseDir: string, relative: string): { path: string; ok: boolean } {
  if (!baseDir) return { path: "", ok: false };
  if (relative.startsWith("/") || relative.startsWith("~")) return { path: "", ok: false };
  const trimmed = relative.trim();
  if (!trimmed) return { path: "", ok: false };

  const base = standardize(baseDir);
  const target = standardize(base + "/" + trimmed);
  // base 内側（かつ base 自体でない）のみ許可（`..` 脱出を拒否）。
  if (target === base || !isInsideBase(target, base)) return { path: target, ok: false };

  try {
    fs.mkdirSync(target, { recursive: true });
    return { path: target, ok: true };
  } catch {
    return { path: target, ok: false };
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
