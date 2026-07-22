// remoteQuestionMonitor.ts
// tailii (TS host) — foreground connected 中に別 conversation の AskUserQuestion を検知する軽量 monitor。

import * as path from "node:path";
import type { LineWriter } from "./lineWriter.js";
import { claudeProjectSlug } from "./paths.js";
import { PROTOCOL_V1 } from "./protocol.js";
import type { SessionMetadataStore, SessionMeta } from "./sessionMetadataStore.js";
import { abortableSleep } from "./sleep.js";
import { HISTORY_DONE_STREAM_ID, TranscriptTailer } from "./transcriptTailer.js";
import type { SessionBackend } from "./sessionBackend.js";

export class RemoteQuestionMonitor {
  private readonly sessionManager: SessionBackend;
  private readonly metadataStore: SessionMetadataStore;
  private readonly projectsRoot: string;
  private readonly writer: LineWriter;
  private readonly activeSession: () => string | null;
  private readonly pollIntervalMs: number;
  private readonly pumps = new Map<string, AbortController>();
  private loopAbort: AbortController | null = null;
  private loopTask: Promise<void> | null = null;

  constructor(options: {
    sessionManager: SessionBackend;
    metadataStore: SessionMetadataStore;
    projectsRoot: string;
    writer: LineWriter;
    activeSession: () => string | null;
    pollIntervalMs?: number;
  }) {
    this.sessionManager = options.sessionManager;
    this.metadataStore = options.metadataStore;
    this.projectsRoot = options.projectsRoot;
    this.writer = options.writer;
    this.activeSession = options.activeSession;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  start(): void {
    if (this.loopTask !== null) return;
    const ac = new AbortController();
    this.loopAbort = ac;
    this.loopTask = this.run(ac.signal);
    this.loopTask.catch(() => {});
  }

  stop(): void {
    this.loopAbort?.abort();
    this.loopAbort = null;
    this.loopTask = null;
    for (const pump of this.pumps.values()) pump.abort();
    this.pumps.clear();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.syncOnce(signal);
      await abortableSleep(this.pollIntervalMs, signal);
    }
  }

  private async syncOnce(signal: AbortSignal): Promise<void> {
    let live = new Set<string>();
    try {
      live = new Set((await this.sessionManager.list()).filter((s) => s.alive).map((s) => s.name));
    } catch {
      live = new Set<string>();
    }
    const active = this.activeSession();
    const wanted = new Map<string, SessionMeta>();
    for (const meta of this.metadataStore.all()) {
      if (!live.has(meta.name)) continue;
      if (meta.name === active) continue;
      if ((meta.agent ?? "claude") !== "claude") continue;
      if (meta.claudeSessionId === undefined) continue;
      wanted.set(meta.name, meta);
    }

    for (const name of this.pumps.keys()) {
      if (!wanted.has(name)) {
        this.pumps.get(name)?.abort();
        this.pumps.delete(name);
      }
    }
    for (const meta of wanted.values()) {
      if (this.pumps.has(meta.name)) continue;
      this.startPump(meta, signal);
    }
  }

  private startPump(meta: SessionMeta, parentSignal: AbortSignal): void {
    const ac = new AbortController();
    this.pumps.set(meta.name, ac);
    const dir = path.join(this.projectsRoot, claudeProjectSlug(meta.cwd));
    const tailer = new TranscriptTailer({ tailIndefinitely: true, emitReplayDoneMarker: true });
    (async () => {
      let replayDone = false;
      try {
        for await (const message of tailer.streamProjectDir(
          dir,
          meta.claudeSessionId ?? null,
          null,
          ac.signal,
        )) {
          if (parentSignal.aborted || ac.signal.aborted) break;
          if (message.type === "chat_output" && message.streamId === HISTORY_DONE_STREAM_ID) {
            replayDone = true;
            continue;
          }
          if (!replayDone) continue;
          if (message.type === "question_prompt") {
            const first = message.questions[0];
            const summary = first?.question || first?.header || "Question prompt";
            this.writer.write({
              type: "remote_pending",
              v: PROTOCOL_V1,
              id: message.id,
              session: meta.name,
              kind: "question",
              summary,
            });
          } else if (message.type === "question_dismiss") {
            this.writer.write({
              type: "remote_pending_cleared",
              v: PROTOCOL_V1,
              id: message.id,
              session: meta.name,
              kind: "question",
            });
          }
        }
      } finally {
        if (this.pumps.get(meta.name) === ac) this.pumps.delete(meta.name);
      }
    })().catch(() => {});
  }
}
