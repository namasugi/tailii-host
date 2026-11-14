// engine/handlers/peerCheck.ts
// 既存の会話を開く前に、他所で動いている同じ会話を確かめ、確認のうえで開き直す（peer-takeover）。
// 判定の本体は services/peerTakeover.ts。ここは session_start / session_reattach との結線と、会話ごとの排他。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyPeers,
  defaultPeerProbe,
  takeoverToken,
  terminateTakeoverTarget,
  verifyTakeover,
  type PeerClassification,
  type PeerProbe,
  type TakeoverTarget,
} from "../../services/peerTakeover.js";
import {
  defaultHerdrPath,
  isValidHerdrSessionName,
  parseHerdrForegroundPids,
  processHerdrCommandRunner,
} from "../../backend/herdr.js";
import type { LaunchTakeover } from "../../commands/launch.js";
import type { ControlMessage } from "../../protocol.js";
import type { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";

type PeerConflict = Extract<ControlMessage, { type: "session_peer_conflict" }>;

export type PeerCheckOutcome =
  | { kind: "proceed" }
  | { kind: "conflict"; conflict: Omit<PeerConflict, "type" | "v" | "id"> }
  | { kind: "takeover"; takeover: LaunchTakeover };

/** herdr の pane の前面にその pid が居るか（環境変数の手がかりの検証。配置にだけ使う, Fable A-14）。 */
export async function herdrPaneHasPid(session: string, paneId: string, pid: number): Promise<boolean> {
  if (!isValidHerdrSessionName(session) || !/^w\d+:p[A-Za-z0-9]+$/.test(paneId)) return false;
  try {
    const result = await processHerdrCommandRunner(defaultHerdrPath(), session, 3_000)(
      ["pane", "process-info", "--pane", paneId],
    );
    return result.exitCode === 0 && parseHerdrForegroundPids(result.stdout).includes(pid);
  } catch {
    return false;
  }
}

function classify(
  conversationId: string,
  probe: PeerProbe,
  store: SessionMetadataStore | null,
): Promise<PeerClassification> {
  return classifyPeers(
    conversationId,
    probe,
    (name) => store?.get(name)?.name === name,
    herdrPaneHasPid,
  );
}

function conflictFor(
  conversationId: string,
  classification: Exclude<PeerClassification, { kind: "none" }>,
  reason?: string,
): Omit<PeerConflict, "type" | "v" | "id"> {
  if (classification.kind === "takeover") {
    const target = classification.target;
    return {
      conversationId,
      holder: target.herdr !== null ? "herdr" : "terminal",
      holderName: target.name,
      busy: target.busy,
      canTakeOver: true,
      token: takeoverToken(target),
      ...(target.herdr !== null ? { herdrSession: target.herdr.session } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  if (classification.kind === "parallel") {
    return {
      conversationId,
      holder: classification.holder,
      holderName: classification.name,
      busy: classification.busy,
      canTakeOver: false,
      reason: classification.reason,
    };
  }
  return { conversationId, holder: "unknown", busy: false, canTakeOver: false, reason: classification.reason };
}

const VERDICT_REASON = {
  expired: "確認から時間が経ちました。もう一度確かめてください。",
  changed: "相手の状態が変わりました。もう一度確かめてください。",
  busy: "相手が処理中になりました。中断して開き直すか確かめてください。",
  malformed: "確認の内容を読めませんでした。もう一度確かめてください。",
} as const;

/**
 * session_start（既存の会話の再開）の前の判定。旧アプリ（peerCheck も takeOver も無い）と並走の同意（allowParallel）は
 * 確かめずに進める（従来どおり）。
 */
/**
 * 掴んでいるのが、この会話の Tailii のセッション自身か（開こうとしている名前そのもの、またはメタがこの会話 id を
 * 記録している Tailii のセッション）。そうなら確認は要らない（起動はその pane を使い回す / 別名として再利用する）。
 * Tailii の会話の中で `/resume` して別の会話に切り替えた Claude（メタの会話 id が違う）だけが確認の対象。
 */
function isOwnTailiiHolder(
  classification: PeerClassification,
  conversationId: string,
  requestedName: string | undefined,
  store: SessionMetadataStore | null,
): boolean {
  if (classification.kind !== "parallel" || classification.holder !== "tailii") return false;
  const name = classification.tailiiSession;
  if (name === undefined) return false;
  if (name === requestedName) return true;
  const meta = store?.get(name);
  return meta?.providerSessionId === conversationId || meta?.claudeSessionId === conversationId;
}

export async function checkPeersBeforeResume(options: {
  conversationId: string;
  /** 開こうとしている会話名（その名前の Tailii のセッションが掴んでいるなら確認しない）。 */
  requestedName?: string;
  peerCheck: boolean;
  takeOver: { token: string; interrupt?: boolean } | undefined;
  allowParallel: boolean;
  store: SessionMetadataStore | null;
  probe?: PeerProbe;
  log?: (line: string) => void;
}): Promise<PeerCheckOutcome> {
  const { conversationId, takeOver } = options;
  if (options.allowParallel || (!options.peerCheck && takeOver === undefined)) return { kind: "proceed" };
  const probe = options.probe ?? defaultPeerProbe();
  const classification = await classify(conversationId, probe, options.store);
  options.log?.(`peer check conversation=${conversationId} kind=${classification.kind}`);
  if (classification.kind === "none") return { kind: "proceed" };
  if (isOwnTailiiHolder(classification, conversationId, options.requestedName, options.store)) return { kind: "proceed" };
  if (classification.kind !== "takeover" || takeOver === undefined) {
    return { kind: "conflict", conflict: conflictFor(conversationId, classification) };
  }
  const verdict = verifyTakeover(takeOver.token, classification.target, takeOver.interrupt === true);
  if (!verdict.ok) {
    return { kind: "conflict", conflict: conflictFor(conversationId, classification, VERDICT_REASON[verdict.reason]) };
  }
  const confirmed = classification.target;
  return {
    kind: "takeover",
    takeover: {
      herdr: confirmed.herdr,
      // 終了の直前にもう一度分類し、同じ相手で同意の範囲内（処理中への変化は中断の同意が要る）なら SIGTERM する。
      terminate: async () => {
        const again = await classify(conversationId, probe, options.store);
        if (again.kind === "none") return true;
        if (again.kind !== "takeover" || !sameTarget(again.target, confirmed) ||
          (again.target.busy && takeOver.interrupt !== true)) {
          options.log?.(`peer takeover 見送り（直前の再確認で不一致） conversation=${conversationId} kind=${again.kind}`);
          return false;
        }
        const ok = probe.terminate !== undefined
          ? await probe.terminate(again.target)
          : await terminateTakeoverTarget(again.target);
        options.log?.(`peer takeover terminate pid=${again.target.pid} ok=${ok}`);
        return ok;
      },
    },
  };
}

function sameTarget(a: TakeoverTarget, b: TakeoverTarget): boolean {
  return a.pid === b.pid && a.procStart === b.procStart && a.conversationId === b.conversationId;
}

/**
 * 自動の再起動（session_reattach で pane が無いとき）の前の判定。他所で同じ会話が動いていれば再起動しない
 * （確認なしに 2 つ目を起動しない, Fable A-3）。判別できないときも再起動しない。
 */
export async function peerBlocksAutoRestart(
  conversationId: string,
  store: SessionMetadataStore | null,
  probe: PeerProbe = defaultPeerProbe(),
  requestedName?: string,
): Promise<boolean> {
  const classification = await classify(conversationId, probe, store);
  if (classification.kind === "none") return false;
  // 再起動しようとしている名前そのものの Claude なら塞がない（pane の解決が一時的に外れただけ）。
  return !(classification.kind === "parallel" && classification.holder === "tailii" &&
    classification.tailiiSession === requestedName);
}

/** 会話ごとの開き直しの排他（端末が違えば engine も別プロセスなのでファイルで取る, Fable A-5）。 */
export interface TakeoverLock {
  release(): void;
}

export function acquireTakeoverLock(
  conversationId: string,
  dir: string = path.join(os.homedir(), ".tailii", "run"),
): TakeoverLock | null {
  const safeId = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  const file = path.join(dir, `takeover-${safeId}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try { fs.rmSync(file, { force: true }); } catch { /* 次の取得で残骸として外す */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      // 持ち主のプロセスが終わっていれば残骸として外して取り直す。
      let holder = Number.NaN;
      try { holder = Number(fs.readFileSync(file, "utf8").trim()); } catch { /* 読めなければ生きている扱い */ }
      let alive = true;
      if (Number.isInteger(holder) && holder > 0) {
        try { process.kill(holder, 0); } catch (killError) {
          alive = (killError as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) return null;
      try { fs.rmSync(file, { force: true }); } catch { return null; }
    }
  }
  return null;
}
