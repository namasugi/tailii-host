// systemNotice.ts
// tailii (TS host) — transcript の system 行のうち、利用者に見せるべき通知を日本語の
// system 注記へ転写する純ロジック（TESTABLE, system-notice）。
//
// 背景（2026-09-04 実障害）: Fable 5.1 のセーフガードが応答を退け、Claude Code が Opus 4.8 へ
// 自動フォールバックした。transcript には `system/model_refusal_fallback` として残るが tailer が
// 落としていたため、アプリでは「理由なくモデル表示が変わった」ように見えた。同型で握り潰して
// いた system 行を棚卸しし（14日分・全 subtype/level を集計）、利用者に意味のあるものだけを
// ここで一元的に転写する:
//   - model_refusal_fallback / model_consent_fallback（warning）: モデルの自動切替
//   - api_error（error）: API エラー（初回試行のみ。再試行ごとに並べない）
//   - compact_boundary（info）: 会話の圧縮（文脈が消えた理由）
//   - それ以外の level=warning/error で本文があるもの（例: informational「Remote Control
//     disconnected — /login」）: 汎用注記。新しい警告 subtype も自動で表に出る（future-proof）
// 派生・内部情報（turn_duration / stop_hook_summary / away_summary / notice 級 / info 級の
// 未知 subtype）は従来どおり流さない。bridge_status / local_command は tailer 側の既存分岐が担う。

/**
 * Claude のモデル id を表示名へ（`claude-fable-5-1` → `Fable 5.1`、`claude-opus-5[1m]` →
 * `Opus 5 (1M)`、`claude-haiku-4-5-20251001` → `Haiku 4.5`）。未知の形はそのまま返す。
 * iOS 側のカタログに依存せず、host だけで人間向け表記を作る最小変換。
 */
export function claudeModelDisplayName(id: string): string {
  let core = id;
  let suffix = "";
  const bracket = /\[([^\]]+)\]$/.exec(core);
  if (bracket) {
    suffix = ` (${(bracket[1] ?? "").toUpperCase()})`;
    core = core.slice(0, bracket.index);
  }
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(core);
  if (!match) return id;
  const family = (match[1] ?? "");
  const familyName = family.charAt(0).toUpperCase() + family.slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : `${match[2]}`;
  return `${familyName} ${version}${suffix}`;
}

function str(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * system 行 1 件を利用者向け注記へ転写する。表に出さない行は null。
 * 返す文字列は iOS の system 行としてそのまま表示される（先頭の絵文字で種別を示す）。
 */
export function systemNoticeText(rec: Record<string, unknown>): string | null {
  const subtype = str(rec, "subtype");
  const level = str(rec, "level");
  const content = (str(rec, "content") ?? "").trim();

  // --- モデルの自動切替（セーフガード退け / 利用枠） ---
  if (subtype === "model_refusal_fallback" || subtype === "model_consent_fallback") {
    const to = str(rec, "fallbackModel");
    if (to === null) return content.length > 0 ? `⚠️ ${content}` : null;
    const from = str(rec, "originalModel");
    const toName = claudeModelDisplayName(to);
    const fromName = from !== null ? claudeModelDisplayName(from) : "元のモデル";
    if (subtype === "model_refusal_fallback") {
      const category = str(rec, "apiRefusalCategory");
      const reason = category !== null ? `（判定: ${category}）` : "";
      return (
        `⚠️ セーフガードにより ${fromName} が応答を退けたため、${toName} へ切り替えました${reason}。` +
        `以降この会話は ${toName} で応答します。/model で変更できます。`
      );
    }
    return (
      `⚠️ ${fromName} は利用クレジットが必要なため、この会話は ${toName} へ切り替わりました。` +
      `/model で変更できます。`
    );
  }

  // --- API エラー（自動再試行の初回だけ。再試行ごとの連投は出さない） ---
  if (subtype === "api_error") {
    const attempt = num(rec, "retryAttempt");
    if (attempt !== null && attempt > 1) return null;
    const error = typeof rec["error"] === "object" && rec["error"] !== null
      ? (rec["error"] as Record<string, unknown>)
      : null;
    const formatted = error !== null ? (str(error, "formatted") ?? str(error, "message")) : null;
    const detail = formatted !== null ? formatted.split("\n")[0]?.trim() ?? formatted : "";
    const max = num(rec, "maxRetries");
    const retry = max !== null ? `（自動再試行中・最大 ${max} 回）` : "（自動再試行中）";
    return detail.length > 0 ? `❌ API エラー: ${detail}${retry}` : `❌ API エラーが発生しました${retry}`;
  }

  // --- 会話の圧縮（文脈が消えた理由を残す） ---
  if (subtype === "compact_boundary") {
    const meta = typeof rec["compactMetadata"] === "object" && rec["compactMetadata"] !== null
      ? (rec["compactMetadata"] as Record<string, unknown>)
      : null;
    const pre = meta !== null ? num(meta, "preTokens") : null;
    const post = meta !== null ? num(meta, "postTokens") : null;
    const trigger = meta !== null ? str(meta, "trigger") : null;
    const how = trigger === "auto" ? "自動で" : trigger === "manual" ? "/compact で" : "";
    const tokens = pre !== null && post !== null ? `（${pre.toLocaleString("en-US")} → ${post.toLocaleString("en-US")} tokens）` : "";
    return `🧹 会話を${how}圧縮しました${tokens}。これより前の詳細は要約に置き換わっています。`;
  }

  // --- 汎用: warning / error 級で本文があるものは表に出す（新しい警告 subtype も自動対応） ---
  if ((level === "warning" || level === "error") && content.length > 0) {
    return `${level === "error" ? "❌" : "⚠️"} ${content}`;
  }

  return null;
}
