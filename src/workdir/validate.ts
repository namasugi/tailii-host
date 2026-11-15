// workdir/validate.ts
// 作業フォルダの変更先の検証（session-workdir-change, 全種類共通）。
//
// 会話の開始（session_start → launch.ts の resolveWorkdir）と同じく「実在するフォルダの絶対パス」なら受け付け、
// 加えて「開ける（読み取り・移動の権限がある）」ことと「制御文字を含まない」ことを確かめる。相対パスと `~` は
// 受け付けない（変更の要求は絶対パスで送る取り決め）。開始と違って作成はしない。

import * as fs from "node:fs";
import { canonicalPath, standardize } from "../shared/paths.js";

export type WorkdirValidation =
  | { ok: true; cwd: string }
  | { ok: false; message: string };

/** 制御文字（改行・タブ・NUL 等）。端末へ打ち込む経路で途中送信・取り違えの元になる。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateWorkdirTarget(requested: string): WorkdirValidation {
  if (typeof requested !== "string" || requested.length === 0 || !requested.startsWith("/")) {
    return { ok: false, message: "作業フォルダは絶対パスで指定してください。" };
  }
  if (CONTROL_CHARACTERS.test(requested)) {
    return { ok: false, message: "この名前のフォルダには変更できません。" };
  }
  const resolved = standardize(requested);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, message: `フォルダが見つかりません: ${resolved}` };
  }
  if (!stat.isDirectory()) return { ok: false, message: `フォルダではありません: ${resolved}` };
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, message: `フォルダを開けません（権限がありません）: ${resolved}` };
  }
  return { ok: true, cwd: canonicalPath(resolved) };
}
