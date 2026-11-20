/** 終了コード（agent-guide に書いた表と同じ）。 */
export const EXIT = {
  ok: 0, internal: 1, usage: 2, notFound: 3, elsewhere: 4, policy: 5, retryLater: 6, timeout: 7,
} as const;

export class ChatError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string, readonly hint?: string,
    readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChatError";
  }
}
