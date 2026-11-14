// 本文の有限再生に画像の位置だけを補い、ページに入る画像と同一パスの照合分だけを生成する。
import type { ControlMessage } from "../protocol.js";
import { attachmentImagePaths, readImagePath, type ImageService } from "../chat/imageService.js";
import { sliceHistoryPage, type HistoryPageAnchor, type HistoryPageSlice } from "./historyPage.js";

type Image = Extract<ControlMessage, { type: "image_available" }>;
interface Source {
  id: string;
  path: string;
  attachment: boolean;
  index: number;
}
interface PathImages {
  sources: Source[];
  /** 先頭から発話順に確定した結果。失敗・添付による Read 抑止も null として保持する。 */
  results: Array<Image | null>;
  attached: boolean;
  pending: Promise<Image | null> | null;
}

export class HistoryPageImages {
  private readonly events: ControlMessage[] = [];
  private readonly slots = new Map<ControlMessage, Source>();
  private readonly paths = new Map<string, PathImages>();
  private needsFullImageReplay = false;
  /** 全画像生成へ戻る場合も、同じ履歴内で確定したイベント列を再利用する。 */
  private readonly fullEvents: ControlMessage[] = [];
  private fullIndex = 0;

  constructor(events: readonly ControlMessage[], private readonly service: ImageService | undefined) {
    // 旧 factory が画像を生成済みなら、その全再生出力を従来どおり切り出す（再生成して増やさない）。
    if (service === undefined || events.some((event) => event.type === "image_available")) {
      this.events = [...events];
      return;
    }
    const ids = new Map<string, string>();
    const add = (imagePath: string, id: string, attachment: boolean): void => {
      // 同じ画像 ID が別パスに再利用される記録は、prefix の生成で fetch の逆引きを巻き戻し得る。
      // その形だけは全画像を従来の発話順に生成してから切り出す。
      if (ids.has(id) && ids.get(id) !== imagePath) this.needsFullImageReplay = true;
      ids.set(id, imagePath);
      this.add(imagePath, id, attachment);
    };
    for (const event of events) {
      this.events.push(event);
      if (event.type === "chat_output" && event.role === "user") {
        for (const [index, imagePath] of attachmentImagePaths(event.text).entries()) {
          add(imagePath, `att-${event.streamId}-${index}`, true);
        }
      } else if (event.type === "tool_activity") {
        const imagePath = readImagePath(event.activity);
        if (imagePath !== null) add(imagePath, `read-${event.activity.id}`, false);
      }
    }
  }

  /** 画像の位置も含めて先に切り出す。本文だけの切り出し後に画像を末尾へ足すと、境界・更新行でずれる。 */
  async slice(anchor: HistoryPageAnchor | null, limit: number, signal: AbortSignal): Promise<HistoryPageSlice> {
    signal.throwIfAborted();
    if (this.needsFullImageReplay) return this.sliceFullImages(anchor, limit, signal);
    const page = sliceHistoryPage(this.events, anchor, limit);
    const events: ControlMessage[] = [];
    for (const event of page.events) {
      signal.throwIfAborted();
      const source = this.slots.get(event);
      if (source === undefined) {
        events.push(event);
        continue;
      }
      const image = await this.resolveImage(source, signal);
      if (image !== null) events.push(image);
    }
    signal.throwIfAborted();
    return { ...page, events };
  }

  private async resolveImage(source: Source, signal: AbortSignal): Promise<Image | null> {
    const state = this.paths.get(source.path)!;
    // 後ろの Read / 添付を先に要求されても、同一パスの先行分から確定する。
    // 結果と添付成功の判定はページをまたいで保持し、後の成功で過去の失敗を復活させない。
    while (state.results.length <= source.index) {
      signal.throwIfAborted();
      if (state.pending === null) {
        const candidate = state.sources[state.results.length]!;
        const pending = (async () => {
          const image = !candidate.attachment && state.attached ? null
            : await this.service!.makeAvailable(candidate.path, candidate.id);
          state.results.push(image);
          if (candidate.attachment && image !== null) state.attached = true;
          return image;
        })();
        state.pending = pending;
        // 取消で待ち手が消えても、開始済みの1件の結果は同じ履歴へ確定する。
        // 例外の場合も同じ rejected Promise を保ち、次のページで再評価しない。
        void pending.then(() => { state.pending = null; }, () => {});
      }
      await cancelledWith(state.pending, signal);
      signal.throwIfAborted();
      // 同じ画像への大量の再実行がメモに当たる場合にも、取消・期限へ制御を返す。
      if (state.results.length % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return state.results[source.index]!;
  }

  private async sliceFullImages(anchor: HistoryPageAnchor | null, limit: number, signal: AbortSignal): Promise<HistoryPageSlice> {
    while (this.fullIndex < this.events.length) {
      signal.throwIfAborted();
      const index = this.fullIndex;
      const event = this.events[index]!;
      const source = this.slots.get(event);
      if (source === undefined) {
        this.fullEvents.push(event);
        this.fullIndex += 1;
      } else {
        const image = await this.resolveImage(source, signal);
        signal.throwIfAborted();
        // 複数ページが同じ画像を待っていた場合も、発話順の列へ足すのは一度だけ。
        if (this.fullIndex === index) {
          if (image !== null) this.fullEvents.push(image);
          this.fullIndex += 1;
        }
      }
      if (this.fullIndex % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal.throwIfAborted();
    return sliceHistoryPage(this.fullEvents, anchor, limit);
  }

  private add(imagePath: string, id: string, attachment: boolean): void {
    const state = this.paths.get(imagePath) ?? { sources: [], results: [], attached: false, pending: null };
    const source = { id, path: imagePath, attachment, index: state.sources.length };
    state.sources.push(source);
    this.paths.set(imagePath, state);
    // この札は内部の位置計算専用。サムネを生成できた札だけを実際の通知へ置き換える。
    const slot: Image = { type: "image_available", v: 1, id, path: imagePath,
      mime: "image/png", thumbnail: "", width: 0, height: 0 };
    this.events.push(slot);
    this.slots.set(slot, source);
  }
}

/** サムネ自体は ImageService が共有する。要求の取消では待ち手だけを直ちに解く。 */
function cancelledWith<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    const finish = (callback: () => void): void => {
      signal.removeEventListener("abort", abort);
      callback();
    };
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
