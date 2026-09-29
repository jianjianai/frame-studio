// Clear only the exact draft acknowledged by the server, never later edits or another conversation.
/** @typedef {{text: string, version: number, conversation: number}} DraftSnapshot */
/** @param {DraftSnapshot} sent @param {DraftSnapshot} current */
export function canClearDraft(sent, current) {
  return sent.text === current.text && sent.version === current.version && sent.conversation === current.conversation;
}

/** @typedef {DraftSnapshot & {work: string, chat: string, connection: string, usePosition: boolean, assetIds: string[]}} SubmissionSnapshot */
/** @param {SubmissionSnapshot} previous @param {SubmissionSnapshot} current */
export function canReuseSubmission(previous, current) {
  return canClearDraft(previous, current) && previous.work === current.work && previous.chat === current.chat &&
    previous.connection === current.connection && previous.usePosition === current.usePosition &&
    previous.assetIds.length === current.assetIds.length && previous.assetIds.every((id, index) => id === current.assetIds[index]);
}
