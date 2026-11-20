import type { PendingApprovalRecord } from "../../approval/approvalMailbox.js";
import type { QuestionPromptQuestion } from "../../protocol.js";
import type { SessionMetadataStore } from "../../sessions/sessionMetadataStore.js";

/** 会話 id を収容している Tailii の会話名（メタから）。 */
export function sessionNamesForConversation(store: SessionMetadataStore, conversationId: string): string[] {
  return store.all()
    .filter((meta) => meta.providerSessionId === conversationId || meta.claudeSessionId === conversationId)
    .map((meta) => meta.name);
}

export interface PendingQuestion { session: string; id: string; questions: QuestionPromptQuestion[] }

export function questionView(question: PendingQuestion): Record<string, unknown> {
  return {
    questionId: question.id,
    questions: question.questions.map((entry, index) => ({
      number: index + 1, header: entry.header, question: entry.question, multiSelect: entry.multiSelect,
      options: entry.options.map((option, optionIndex) => ({
        choice: optionIndex + 1, label: option.label, ...(option.description.length > 0 ? { description: option.description } : {}),
      })),
    })),
  };
}

export function approvalViews(approvals: readonly PendingApprovalRecord[]): Array<Record<string, unknown>> {
  return approvals.map((approval) => ({
    approvalId: approval.id, tool: approval.tool, summary: approval.summary,
    ...(approval.agentType !== undefined ? { agentType: approval.agentType } : {}),
  }));
}
