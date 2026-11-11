// pushDeviceStore.ts
// tailii (TS host) — プッシュ通知の宛先端末の保存（複数端末）
//
// `~/.tailii/push/devices/<deviceId>.json` に 1 端末 1 ファイルで保存する（ディレクトリ 0700・ファイル 0600）。
// 中身は設計 docs/push-notifications.md §9 の形。**書き手は hub だけ**（engine は登録・解除を hub へ中継し、
// hook の自前送信と doctor は読むだけ）。`deviceId` はファイル名に使うので UUID の形だけを受け付ける
// （パス走査を許さない）。旧 `~/.tailii/apns/device-token.json`（単一端末・暗号鍵なし）は新しい登録の初回に
// 読み捨てる（暗号鍵が無いので新しい形の通知には使えない）。
//
// pushKey / capability / device token は秘密。ログ・例外メッセージに出さない。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ApnsHost, defaultApnsBase, isApnsHost } from "./pushTypes.js";
import { decodePushKey } from "./pushEnvelope.js";

/** 既定の push ディレクトリ（`~/.tailii/push`）。 */
export function defaultPushBase(): string {
  return path.join(os.homedir(), ".tailii", "push");
}

/** 種別ごとの通知設定（契約 §1 の `prefs`。解決済み = すべて bool）。 */
export interface PushPrefs {
  turnDone: boolean;
  question: boolean;
  approval: boolean;
  usageLimit: boolean;
  turnError: boolean;
  showBody: boolean;
}

export const PUSH_PREF_KEYS: readonly (keyof PushPrefs)[] = [
  "turnDone", "question", "approval", "usageLimit", "turnError", "showBody",
];

/** 契約 §1: `prefs` に無いキーは true 扱い。 */
export function resolvePushPrefs(partial: Partial<Record<keyof PushPrefs, boolean>> | undefined): PushPrefs {
  const resolved = {} as PushPrefs;
  for (const key of PUSH_PREF_KEYS) resolved[key] = partial?.[key] ?? true;
  return resolved;
}

/** リレー経路の宛先情報（capability は不透明な秘密）。 */
export interface PushRelayInfo {
  url: string;
  capability: string;
  /** epoch 秒。 */
  expiresAt: number;
  /** リレーが 401 を返した印。同じ capability のまま再登録されても残し、アプリに取り直しを促す。 */
  invalid?: boolean;
}

/** 1 端末分の記録。 */
export interface PushDeviceRecord {
  deviceId: string;
  deviceName: string;
  /** hex。 */
  deviceToken: string;
  environment: ApnsHost;
  bundleId: string;
  /** b64u・32 バイト。 */
  pushKey: string;
  relay?: PushRelayInfo;
  prefs: PushPrefs;
  /** epoch 秒。 */
  updatedAt: number;
  /**
   * 保存のたびに変わる版（保存時に store が振る。外から渡した値は無視する）。送信を始めた時点の版と
   * 応答を受けた時点の版が違えば、その間に再登録されたので 401 / 410 の結果を反映しない。
   */
  revision?: string;
}

const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const FILE_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.json$/u;
/** 小文字 16 進・偶数桁（リレーと同じ）。長さは APNs の device token の上限（100 バイト）まで。 */
const HEX_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){8,100}$/u;

/** `deviceId` が UUID の形か（ファイル名に使う前の唯一の関門）。 */
export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** 保存・照合に使う正規形（大文字）。 */
export function normalizeDeviceId(deviceId: string): string {
  return deviceId.toUpperCase();
}

/** device token が小文字 hex か（契約 §1 は hex = 小文字 16 進）。 */
export function isValidDeviceToken(value: unknown): value is string {
  return typeof value === "string" && HEX_TOKEN_PATTERN.test(value);
}

/** 端末の記録を消した結果（push_unregister の応答に使う）。 */
export type PushDeviceDeleteResult = "deleted" | "absent" | "failed";

/**
 * 宛先端末の記録。**書くのは hub だけ**（engine の push_register / push_unregister は hub へ中継する）。
 * 生成時に全件を読み込んでメモリに持ち、書き込みのたびにメモリとファイル（一時ファイル → rename）を更新する。
 * hub は単一スレッドで、各操作は同期の読み書きで完結するので、同じ端末への操作が交互に混ざることはない。
 * hook の自前送信と doctor は、新しく作ったインスタンスで読むだけ（rename で書かれるので途中の状態は見えない）。
 */
export class PushDeviceStore {
  private readonly base: string;
  private readonly legacyApnsBase: string;
  private records: Map<string, PushDeviceRecord> | null = null;
  /** 初回の読み込みで I/O エラーになった端末 id（次の操作で読み直す）。 */
  private readonly unreadableIds = new Set<string>();

  constructor(options: { base?: string; legacyApnsBase?: string } = {}) {
    this.base = options.base ?? defaultPushBase();
    this.legacyApnsBase = options.legacyApnsBase ?? defaultApnsBase();
  }

  private get devicesDir(): string {
    return path.join(this.base, "devices");
  }

  private fileFor(deviceId: string): string {
    if (!isValidDeviceId(deviceId)) throw new Error("invalid deviceId");
    return path.join(this.devicesDir, `${normalizeDeviceId(deviceId)}.json`);
  }

  /** 初回の操作で全件を読み込む（壊れたファイル・名前と中身が食い違うファイルは飛ばす）。 */
  /** 一覧（初回だけ読み込み、その後は初回に読めなかった端末・ディレクトリを読み直す）。 */
  private loaded(): Map<string, PushDeviceRecord> {
    const records = this.memory();
    this.retryUnreadable();
    return records;
  }

  /** メモリ上の一覧（初回だけ全件を読み込む。読み直しはしない）。 */
  private memory(): Map<string, PushDeviceRecord> {
    if (this.records !== null) return this.records;
    const records = new Map<string, PushDeviceRecord>();
    this.records = records;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.devicesDir);
    } catch (error) {
      // ディレクトリが読めなかった（無い以外）。空のまま覚えず、次の操作で読み直す。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.records = null;
      return records;
    }
    for (const name of names.sort()) {
      if (!FILE_PATTERN.test(name)) continue;
      const id = name.slice(0, -".json".length);
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.devicesDir, name), "utf8");
      } catch (error) {
        // 一時的に読めなかった端末は覚えておき、次の操作で読み直す（空のまま通知が止まり続けないように）。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadableIds.add(id);
        continue;
      }
      let record: PushDeviceRecord | null;
      try {
        record = parseRecord(JSON.parse(text));
      } catch {
        record = null;
      }
      if (record !== null && normalizeDeviceId(record.deviceId) === id) records.set(id, record);
    }
    return records;
  }

  /** 初回の読み込みで読めなかった端末を読み直す（読めた・無くなったものは覚えから外す）。 */
  private retryUnreadable(): void {
    if (this.unreadableIds.size === 0) return;
    for (const id of [...this.unreadableIds]) {
      const state = this.refreshState(id);
      if (state.state !== "unreadable") this.unreadableIds.delete(id);
    }
  }

  /** 保存済みの全端末（呼び手が書き換えてもメモリは汚れない写し）。 */
  list(): PushDeviceRecord[] {
    return [...this.loaded().values()].map(cloneRecord);
  }

  get(deviceId: string): PushDeviceRecord | null {
    if (!isValidDeviceId(deviceId)) return null;
    const record = this.loaded().get(normalizeDeviceId(deviceId));
    return record === undefined ? null : cloneRecord(record);
  }

  /** 端末を保存する（同じ deviceId は上書き = 冪等）。版は新しく振る。保存した記録を返す。 */
  save(record: PushDeviceRecord): PushDeviceRecord {
    const normalized: PushDeviceRecord = { ...cloneRecord(record), deviceId: normalizeDeviceId(record.deviceId), revision: randomUUID() };
    const file = this.fileFor(normalized.deviceId);
    ensurePrivateDirectory(this.base);
    ensurePrivateDirectory(this.devicesDir);
    writePrivateFileAtomic(file, JSON.stringify(normalized));
    this.loaded().set(normalized.deviceId, normalized);
    this.discardLegacyDeviceToken();
    return cloneRecord(normalized);
  }

  /** 直前の記録を見て新しい記録を作り、保存する。build が null を返したら何もしない。 */
  upsert(deviceId: string, build: (previous: PushDeviceRecord | null) => PushDeviceRecord | null): PushDeviceRecord | null {
    const next = build(this.get(deviceId));
    return next === null ? null : this.save(next);
  }

  /** 端末の記録を消す（push_unregister）。もともと無ければ absent、消せなければ failed。 */
  delete(deviceId: string): PushDeviceDeleteResult {
    if (!isValidDeviceId(deviceId)) return "failed";
    const id = normalizeDeviceId(deviceId);
    try {
      fs.unlinkSync(this.fileFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
      return this.loaded().delete(id) ? "deleted" : "absent";
    }
    this.loaded().delete(id);
    return "deleted";
  }

  /**
   * その端末の記録をディスクから読み直してメモリを更新し、最新の記録を返す（無ければ null）。
   * 書き手は hub だけの設計だが、hub が二重に起動した場合（hubDaemon の単一起動の既知の競合）や手で消された
   * 場合にも、破壊的な書き込みと送信の直前にはディスクの内容を正とする。
   */
  refresh(deviceId: string): PushDeviceRecord | null {
    const state = this.refreshState(deviceId);
    return state.state === "present" ? state.record : null;
  }

  /**
   * その端末の記録をディスクから読み直す。ファイルが無い（absent）ならメモリからも消す。読めなかった（I/O エラー・
   * 壊れた中身 = unreadable）ならメモリの記録は残す（その試行は中止し、次の機会に読み直す。一時的な障害で
   * その端末への通知が止まり続けないように）。
   */
  refreshState(deviceId: string): { state: "present"; record: PushDeviceRecord } | { state: "absent" } | { state: "unreadable" } {
    if (!isValidDeviceId(deviceId)) return { state: "absent" };
    const id = normalizeDeviceId(deviceId);
    let text: string;
    try {
      text = fs.readFileSync(this.fileFor(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.memory().delete(id);
        return { state: "absent" };
      }
      return { state: "unreadable" };
    }
    let disk: PushDeviceRecord | null;
    try {
      disk = parseRecord(JSON.parse(text));
    } catch {
      disk = null;
    }
    if (disk === null || normalizeDeviceId(disk.deviceId) !== id) return { state: "unreadable" };
    this.memory().set(id, disk);
    return { state: "present", record: cloneRecord(disk) };
  }

  /**
   * 送信を始めた時点の版のままなら消す（410）。直前にディスクを読み直し、その間に再登録されていれば
   * （別の hub が書いた場合も）消さない。消したら true。
   */
  deleteIfRevision(deviceId: string, revision: string | undefined): boolean {
    const current = this.refresh(deviceId);
    if (current === null || current.revision !== revision) return false;
    return this.delete(deviceId) === "deleted";
  }

  /**
   * リレーが 401 を返した capability に無効の印を付ける。capability が変わった・`revision` を渡して
   * それと版が違う（送信中に再登録された）ときは何もしない。印を付けたら true。
   */
  markCapabilityInvalid(deviceId: string, capability: string, revision?: string): boolean {
    // 直前にディスクを読み直す（別の hub が再登録していれば、その内容を古い版で上書きしない）。
    const current = this.refresh(deviceId);
    if (current?.relay === undefined || current.relay.capability !== capability || current.relay.invalid === true) return false;
    if (revision !== undefined && current.revision !== revision) return false;
    try {
      this.save({ ...current, relay: { ...current.relay, invalid: true } });
      return true;
    } catch {
      return false;
    }
  }

  /** 旧 `apns/device-token.json`（暗号鍵なし・単一端末）を読み捨てる。 */
  private discardLegacyDeviceToken(): void {
    try {
      fs.rmSync(path.join(this.legacyApnsBase, "device-token.json"), { force: true });
    } catch {
      // 残っていても新しい経路は読まない。
    }
  }
}

/** ディレクトリを 0700 で用意する（既存でも権限を揃える）。 */
export function ensurePrivateDirectory(dir: string): void {
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error("push path exists but is not a directory");
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
}

/** 0600 の一時ファイルへ書いてから rename する（途中で落ちても壊れたファイルを残さない）。 */
export function writePrivateFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 後片付けの失敗は無視。 */ }
    throw error;
  }
}

function readRecord(file: string): PushDeviceRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return parseRecord(raw);
}

/** 保存形式を検証して読む（手で壊されたファイルを送信に使わない）。 */
export function parseRecord(raw: unknown): PushDeviceRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    !isValidDeviceId(obj["deviceId"]) ||
    typeof obj["deviceName"] !== "string" ||
    !isValidDeviceToken(obj["deviceToken"]) ||
    !isApnsHost(obj["environment"]) ||
    typeof obj["bundleId"] !== "string" ||
    typeof obj["pushKey"] !== "string" || decodePushKey(obj["pushKey"]) === null ||
    typeof obj["updatedAt"] !== "number"
  ) {
    return null;
  }
  const prefsRaw = obj["prefs"];
  const prefsPartial: Partial<Record<keyof PushPrefs, boolean>> = {};
  if (typeof prefsRaw === "object" && prefsRaw !== null && !Array.isArray(prefsRaw)) {
    for (const key of PUSH_PREF_KEYS) {
      const value = (prefsRaw as Record<string, unknown>)[key];
      if (typeof value === "boolean") prefsPartial[key] = value;
    }
  }
  let relay: PushRelayInfo | undefined;
  const relayRaw = obj["relay"];
  if (typeof relayRaw === "object" && relayRaw !== null && !Array.isArray(relayRaw)) {
    const r = relayRaw as Record<string, unknown>;
    if (typeof r["url"] === "string" && typeof r["capability"] === "string" && typeof r["expiresAt"] === "number") {
      relay = {
        url: r["url"],
        capability: r["capability"],
        expiresAt: r["expiresAt"],
        ...(r["invalid"] === true ? { invalid: true } : {}),
      };
    }
  }
  return {
    deviceId: obj["deviceId"],
    deviceName: obj["deviceName"],
    deviceToken: obj["deviceToken"],
    environment: obj["environment"],
    bundleId: obj["bundleId"],
    pushKey: obj["pushKey"],
    ...(relay !== undefined ? { relay } : {}),
    prefs: resolvePushPrefs(prefsPartial),
    updatedAt: obj["updatedAt"],
    ...(typeof obj["revision"] === "string" ? { revision: obj["revision"] } : {}),
  };
}

function cloneRecord(record: PushDeviceRecord): PushDeviceRecord {
  return {
    ...record,
    prefs: { ...record.prefs },
    ...(record.relay !== undefined ? { relay: { ...record.relay } } : {}),
  };
}
