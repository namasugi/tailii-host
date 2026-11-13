// agentPriority.ts
// tailii (TS host) — エージェント側のプロセスを utility の優先度に固定する接頭辞（agent-priority）。
//
// 背景: QUIC ゲートウェイの launchd ジョブは `ProcessType=Interactive`（services/quicGateway.ts）で動き、
// その子孫（engine・serve・hub・tmux / herdr のサーバ = 制御側）も同じ優先度を引き継ぐ。何もしないと、
// 次に端末サーバが作り直されたとき pane の中のエージェント（とそのビルド・テスト）まで同じ優先度に上がり、
// ホストが混んだときに制御側が先に動ける差が消える。
//
// そこで「エージェントの作業をするプロセスの木の根」だけを `/usr/sbin/taskpolicy -c utility` 経由で起動し、
// 今までと同じ水準に留める。
// - taskpolicy は対象を exec する（間にプロセスが残らない。pid・コマンド行・親子関係は付けないときと同じ）。
// - 上限（clamp）は子孫へ引き継がれる。兄弟（同じサーバの別の pane・サーバ自体）には及ばない。
// - 付けるのは pane で起動するエージェントの CLI・Codex App Server の daemon・API 作業の worker だけ。
//   hub・engine・serve・ゲートウェイ・端末サーバ・tmux / herdr の短い操作には付けない（制御側）。
//   hook はエージェントの子として起動されるので、付けなくてもエージェントと同じ水準で動く。
//
// macOS 以外・taskpolicy が無い・`TAILII_AGENT_CLAMP=off` のときは何も付けない（今までと同じコマンドになる）。

import * as fs from "node:fs";

/** macOS の taskpolicy（PATH に頼らず絶対パスで呼ぶ）。 */
export const TASKPOLICY_PATH = "/usr/sbin/taskpolicy";

/** 固定を切る環境変数。値が `off` のときだけ無効（未設定・その他は有効）。 */
export const AGENT_CLAMP_ENV = "TAILII_AGENT_CLAMP";

/** 判定の差し替え口（テスト用。省略時はこのプロセスの実物を見る）。 */
export interface AgentClampProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** そのパスが実行できるか。渡したときは結果を覚えない。 */
  isExecutable?: (file: string) => boolean;
}

/** taskpolicy が実行できるかの確認結果（プロセス内で 1 回だけ調べる）。 */
let taskpolicyExecutable: boolean | null = null;

function probeTaskpolicy(): boolean {
  if (taskpolicyExecutable === null) {
    try {
      fs.accessSync(TASKPOLICY_PATH, fs.constants.X_OK);
      taskpolicyExecutable = true;
    } catch {
      taskpolicyExecutable = false;
    }
  }
  return taskpolicyExecutable;
}

/** 覚えた確認結果を捨てる（テスト用）。 */
export function resetAgentClampProbe(): void {
  taskpolicyExecutable = null;
}

/**
 * エージェントを utility に固定して起動するための argv 接頭辞。
 * 固定しないとき（macOS 以外・taskpolicy 不在・`TAILII_AGENT_CLAMP=off`）は空配列。
 */
export function agentClampArgv(probe: AgentClampProbe = {}): string[] {
  if ((probe.platform ?? process.platform) !== "darwin") return [];
  const env = probe.env ?? process.env;
  if (env[AGENT_CLAMP_ENV] === "off") return [];
  const executable = probe.isExecutable !== undefined
    ? probe.isExecutable(TASKPOLICY_PATH)
    : probeTaskpolicy();
  return executable ? [TASKPOLICY_PATH, "-c", "utility"] : [];
}

/**
 * シェル文字列でコマンド名の直前に置く接頭辞（末尾の空白込み）。固定しないときは空文字。
 * 環境変数の代入（`A=1 B=2 <ここ>claude …`）より後ろに置くこと — 代入は taskpolicy の環境になり、
 * exec でそのままエージェントへ渡る。接頭辞の語は固定の安全な文字だけなので引用符は要らない。
 */
export function agentClampShellPrefix(clamp: readonly string[] = agentClampArgv()): string {
  return clamp.length === 0 ? "" : `${clamp.join(" ")} `;
}

/** シェル自身が解釈する語。実行ファイルとして taskpolicy へ渡さない。 */
const SHELL_WORDS = new Set((
  ": . ! [ [[ ]] { } if then elif else fi case esac for select while until do done in function time coproc " +
  "exec command builtin eval cd pwd echo printf read set shift trap umask unset wait return break continue exit " +
  "export readonly getopts hash alias unalias times type ulimit source local declare typeset let enable logout " +
  "pushd popd dirs disown jobs fg bg kill suspend true false test fc help history bind caller mapfile readarray shopt " +
  "compgen complete compopt autoload emulate setopt unsetopt zmodload noglob nocorrect repeat bindkey bye cap chdir " +
  "clone comparguments compcall compctl compdescribe compfiles compgroups compquote comptags comptry compvalues " +
  "disable echotc echoti float functions getcap getln integer limit log print r rehash sched setcap stat ttyctl " +
  "unfunction unhash unlimit vared whence where which zcompile zformat zftp zle zparseopts zprof zpty zregexparse zsocket zstyle ztcp"
).split(" "));

/** 単純な先頭代入と exec は残す。シェル構文・曖昧なコマンドは固定を見送る。 */
export function withAgentClampShellCommand(command: string, clamp: readonly string[] = agentClampArgv()): string {
  const prefix = agentClampShellPrefix(clamp);
  if (prefix === "") return command;
  let assignments = "";
  let rest = command;
  while (/^[ \t]*[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    // 引用符・展開・エスケープ・シェル演算子は解釈しない。元のコマンドをそのまま実行できる方を優先する。
    const match = /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+,~=\-]*(?=[ \t]|$)/.exec(rest);
    if (match === null) return command;
    assignments += match[0];
    rest = rest.slice(match[0].length);
  }
  const space = /^[ \t]*/.exec(rest)![0];
  rest = rest.slice(space.length);
  let exec = "";
  const execMatch = /^exec([ \t]+)/.exec(rest);
  if (execMatch !== null) {
    exec = execMatch[0];
    rest = rest.slice(exec.length);
  }
  // 最初の語がリテラルの実行ファイル名と分かる形だけ。複合コマンドは解釈しない。
  const executable = /^([A-Za-z0-9_./][A-Za-z0-9_./:@%+,=\-]*)(?=[ \t]|$)/.exec(rest)?.[1];
  if (executable === undefined || SHELL_WORDS.has(executable) || executable.includes("=") || /[;&|<>()`\r\n]/.test(rest)) return command;
  return `${assignments}${space}${exec}${prefix}${rest}`;
}

/**
 * spawn / execFile 用。実行ファイルと引数の前に接頭辞を足した組を返す（固定しないときはそのまま）。
 * 起動されるプロセスの pid は付けないときと同じ（taskpolicy が exec で置き換わる）。
 */
export function withAgentClamp(
  executable: string,
  args: readonly string[],
  clamp: readonly string[] = agentClampArgv(),
): { executable: string; args: string[] } {
  const [head, ...rest] = clamp;
  if (head === undefined) return { executable, args: [...args] };
  return { executable: head, args: [...rest, executable, ...args] };
}
