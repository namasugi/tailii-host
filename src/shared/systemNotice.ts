// systemNotice.ts
// tailii (TS host) — transcript の system 行のうち、利用者に見せるべき通知を日本語の
// system 注記へ転写する純ロジック（TESTABLE, system-notice）。
//
// 背景（2026-09-04 実障害）: Fable 5.1 のセーフガードが応答を退け、Claude Code が Opus 4.8 へ
// 自動フォールバックした。transcript には `system/model_refusal_fallback` として残るが tailer が
// 落としていたため、アプリでは「理由なくモデル表示が変わった」ように見えた。同型で握り潰して
// いた system 行を棚卸しし（14日分・全 subtype/level を集計）、利用者に意味のあるものだけを
// ここで一元的に転写する:
//   - assistant 行の `fallback` ブロック（from/to）: 切替の**実時刻**に出す最速の信号
//     （system 行はフォールバック先モデルの最初の応答完了後に書かれ、数十秒〜分単位で遅れる）
//   - model_refusal_fallback / model_consent_fallback（warning）: モデルの自動切替
//     （同じ from→to を fallback ブロックで既に告知済みなら重複させない）
//   - api_error（error）: 初回試行・エラー種別の変化・認証/権限/レート系・再試行上限で出す
//     （同じエラーの再試行ごとの連投は出さない）
//   - compact_boundary（info）: 会話の圧縮（Claude 側の文脈が要約に置き換わった事実）
//   - それ以外の level=warning/error で本文があるもの（例: informational「Remote Control
//     disconnected — /login」）: 汎用注記。新しい警告 subtype も自動で表に出る（future-proof）。
//     ただし端末向けの文言（「run /remote-control to move it to this terminal」= CLI 実行中の会話を
//     Tailii で開いた複製インスタンス並走時の行）は iPhone 上で意味が無いので除く。
// 派生・内部情報（turn_duration / stop_hook_summary / away_summary / notice 級 / info 級の
// 未知 subtype）は従来どおり流さない。bridge_status / local_command は tailer 側の既存分岐が担う。
//
// 連投抑止のため、呼び出し側（tailer の 1 ストリーム）は `SystemNoticeContext` を持ち回る。
// context 無しでも動く（状態に依存する抑止だけが効かない）。

/** 1 ストリーム分の連投抑止状態（tailer が TailState に保持し、行ごとに渡す）。 */
export interface SystemNoticeContext {
  /** 直近に告知した api_error の識別（status + 本文）。同一なら再試行ごとに出さない。 */
  lastApiErrorKey: string | null;
  /** 直近に告知した汎用 warning/error の本文。同一文言の連投を抑える。 */
  lastGenericKey: string | null;
  /** 直近に fallback ブロックから告知した切替（`from->to`）。system 行での重複告知を抑える。 */
  lastFallbackKey: string | null;
}

export function createSystemNoticeContext(): SystemNoticeContext {
  return { lastApiErrorKey: null, lastGenericKey: null, lastFallbackKey: null };
}

/** 生の本文を注記へ載せるときの上限（iOS 側は lineLimit 無しなので host で切る）。 */
const RAW_TEXT_LIMIT = 200;

/** api_error の詳細（formatted / message 1 行目）の上限。 */
const ERROR_DETAIL_LIMIT = 160;

/**
 * Claude のモデル id を表示名へ（`claude-fable-5-1` → `Fable 5.1`、`claude-opus-5[1m]` →
 * `Opus 5 (1M)`、`claude-haiku-4-5-20251001` → `Haiku 4.5`、`claude-sonnet-4-20250514` →
 * `Sonnet 4`）。8 桁の日付接尾辞は版番号より先に剥がす（`-(\d+)` の貪欲一致で
 * `Sonnet 4.20250514` になっていた, 2026-09-04 レビュー指摘）。未知の形はそのまま返す。
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
  core = core.replace(/-\d{8}$/, "");
  const match = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/.exec(core);
  if (!match) return id;
  const family = match[1] ?? "";
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 前後空白を除き、上限を超えたら「…」で切る。改行は 1 スペースへ畳む（system 行は 1 段落）。 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if ([...flat].length <= limit) return flat;
  return [...flat].slice(0, limit).join("") + "…";
}

/** 端末向けで iPhone 上では意味の無い汎用警告（複製インスタンス並走時の RC 案内など）。 */
const TERMINAL_ONLY_WARNING = /Remote Control not started here/;

/** 再試行の途中でも必ず告知するべき HTTP ステータス（認証切れ / 権限 / レート制限）。 */
const NOTABLE_API_STATUSES = new Set([401, 403, 429]);

/** apiRefusalCategory はそのまま埋め込むため、想定外の値（長文・記号）を載せない。 */
const REFUSAL_CATEGORY = /^[a-z0-9_-]{1,32}$/;

function modelSwitchKey(from: string | null, to: string): string {
  return `${from ?? "?"}->${to}`;
}

/**
 * assistant 行の content にある `fallback` ブロック（`{type:"fallback", from:{model}, to:{model}}`,
 * claude 2.1.25x）を切替告知へ。切替の実時刻に書かれる最速の信号で、フォールバック先モデルの
 * 最初のツール実行より前に位置するため、ツールカード群を分断しない。無ければ null。
 */
export function fallbackBlockNotice(content: unknown, ctx?: SystemNoticeContext): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const rec = obj(block);
    if (rec === null || rec["type"] !== "fallback") continue;
    const to = obj(rec["to"]) !== null ? str(obj(rec["to"]) as Record<string, unknown>, "model") : null;
    if (to === null) continue;
    const from = obj(rec["from"]) !== null ? str(obj(rec["from"]) as Record<string, unknown>, "model") : null;
    if (ctx) ctx.lastFallbackKey = modelSwitchKey(from, to);
    const fromName = from !== null ? claudeModelDisplayName(from) : "元のモデル";
    const toName = claudeModelDisplayName(to);
    return (
      `⚠️ ${fromName} が応答を退けたため、${toName} へ切り替えました。` +
      `以降この会話は ${toName} で応答します。/model で変更できます。`
    );
  }
  return null;
}

/**
 * system 行 1 件を利用者向け注記へ転写する。表に出さない行は null。
 * 返す文字列は iOS の system 行としてそのまま表示される（先頭の絵文字で種別を示す）。
 * `ctx` を渡すと連投・重複を抑止する（省略時は行単体で判定）。
 */
export function systemNoticeText(rec: Record<string, unknown>, ctx?: SystemNoticeContext): string | null {
  const subtype = str(rec, "subtype");
  const level = str(rec, "level");
  const content = (str(rec, "content") ?? "").trim();

  // --- モデルの自動切替（セーフガード退け / 利用枠） ---
  if (subtype === "model_refusal_fallback" || subtype === "model_consent_fallback") {
    const to = str(rec, "fallbackModel");
    if (to === null) return content.length > 0 ? `⚠️ ${clip(content, RAW_TEXT_LIMIT)}` : null;
    const from = str(rec, "originalModel");
    const key = modelSwitchKey(from, to);
    // 同じ切替を fallback ブロックで既に告知済み（実時刻）なら、遅れて来る system 行では出さない。
    if (ctx && ctx.lastFallbackKey === key) return null;
    if (ctx) ctx.lastFallbackKey = key;
    const toName = claudeModelDisplayName(to);
    const fromName = from !== null ? claudeModelDisplayName(from) : "元のモデル";
    if (subtype === "model_refusal_fallback") {
      const category = str(rec, "apiRefusalCategory");
      const reason = category !== null && REFUSAL_CATEGORY.test(category) ? `（判定: ${category}）` : "";
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

  // --- API エラー ---
  // 出す条件: 初回試行 / エラー種別が直前の告知と変わった / 認証・権限・レート系 / 再試行上限。
  // 同じエラーの再試行ごとの連投は出さない（実データ: 502 ×1 → 401 ×n。旧実装は初回だけで
  // 「認証切れ（要 /login）」が永遠に出なかった, 2026-09-04 レビュー指摘）。
  if (subtype === "api_error") {
    const error = obj(rec["error"]);
    const status = error !== null ? num(error, "status") : null;
    const formatted = error !== null ? str(error, "formatted") : null;
    const message = error !== null ? str(error, "message") : null;
    const detailSource = formatted ?? (status !== null ? `HTTP ${status}` : (message?.split("\n")[0] ?? null));
    const detail = detailSource !== null ? clip(detailSource, ERROR_DETAIL_LIMIT) : "";
    const attempt = num(rec, "retryAttempt");
    const max = num(rec, "maxRetries");
    const key = `${status ?? "?"}|${detail}`;
    const first = attempt === null || attempt <= 1;
    const changed = ctx ? ctx.lastApiErrorKey !== key : false;
    const notable = status !== null && NOTABLE_API_STATUSES.has(status);
    const exhausted = attempt !== null && max !== null && max > 1 && attempt >= max;
    // context があれば「同じエラーの繰り返し」を抑える。無ければ初回 / 認証系 / 上限だけ。
    const emit = ctx ? (first || changed || exhausted) : (first || notable || exhausted);
    if (!emit) return null;
    if (ctx) ctx.lastApiErrorKey = key;
    const head = detail.length > 0 ? `❌ API エラー: ${detail}` : "❌ API エラーが発生しました";
    if (exhausted) return `${head}（再試行 ${attempt} 回で上限に達しました）`;
    if (notable && status === 401) return `${head}（認証が切れています。/login でログインし直してください）`;
    const retry = max !== null
      ? `（自動再試行 ${attempt ?? 1}/${max} 回目）`
      : "（自動再試行中）";
    return `${head}${retry}`;
  }

  // --- 会話の圧縮（Claude 側の文脈が要約に置き換わった事実を残す） ---
  if (subtype === "compact_boundary") {
    const meta = obj(rec["compactMetadata"]);
    const pre = meta !== null ? num(meta, "preTokens") : null;
    const post = meta !== null ? num(meta, "postTokens") : null;
    const trigger = meta !== null ? str(meta, "trigger") : null;
    const how = trigger === "auto" ? "自動で" : trigger === "manual" ? "/compact で" : "";
    const tokens = pre !== null && post !== null
      ? `（${Math.round(pre).toLocaleString("en-US")} → ${Math.round(post).toLocaleString("en-US")} tokens）`
      : "";
    // アプリは transcript を全再生するので圧縮前の本文もそのまま見える。置き換わったのは
    // Claude 側の文脈（次の応答が参照する記憶）であることが伝わる表現にする。
    return `🧹 会話を${how}圧縮しました${tokens}。Claude 側の文脈は要約に置き換わりました（アプリの表示はそのまま）。`;
  }

  // --- 汎用: warning / error 級で本文があるものは表に出す（新しい警告 subtype も自動対応） ---
  if ((level === "warning" || level === "error") && content.length > 0) {
    if (TERMINAL_ONLY_WARNING.test(content)) return null;
    const body = clip(content, RAW_TEXT_LIMIT);
    if (ctx) {
      if (ctx.lastGenericKey === body) return null;
      ctx.lastGenericKey = body;
    }
    return `${level === "error" ? "❌" : "⚠️"} ${body}`;
  }

  return null;
}
