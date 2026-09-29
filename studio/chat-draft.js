// Clear only the exact draft acknowledged by the server, never later edits or another conversation.
export function canClearDraft(sent, current) {
  return sent.text === current.text && sent.version === current.version && sent.conversation === current.conversation;
}
