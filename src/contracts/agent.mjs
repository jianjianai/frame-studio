import { z } from "zod";

const identifier = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const agentQuestionSchema = z.strictObject({
  id: identifier,
  header: z.string().trim().max(100).default(""),
  question: z.string().trim().min(1).max(4000),
  options: z.array(z.strictObject({
    id: identifier,
    label: z.string().trim().min(1).max(200),
    description: z.string().max(1000).default(""),
  })).max(12).default([]),
  multiSelect: z.boolean().default(false),
  allowOther: z.boolean().default(true),
}).refine((q) => new Set(q.options.map((o) => o.id)).size === q.options.length, "选项 ID 不可重复");
export const agentQuestionRequestSchema = z.strictObject({
  requestKey: identifier,
  title: z.string().trim().max(200).default("需要你的意见"),
  questions: z.array(agentQuestionSchema).min(1).max(4),
}).refine((r) => new Set(r.questions.map((q) => q.id)).size === r.questions.length, "问题 ID 不可重复");
export const agentAnswerSchema = z.record(identifier, z.strictObject({
  selected: z.array(identifier).max(12).default([]),
  text: z.string().trim().max(8000).default(""),
}));
export const agentQuestionAnswerRequestSchema = z.strictObject({
  work: z.string().uuid(),
  task: z.string().uuid(),
  question: z.string().uuid(),
  requestKey: z.string().uuid(),
  answers: agentAnswerSchema,
});
/** @param {z.infer<typeof agentQuestionRequestSchema>} request @param {z.infer<typeof agentAnswerSchema>} answers */
export function validateAgentAnswers(request, answers) {
  const keys = new Set(request.questions.map((q) => q.id));
  if (Object.keys(answers).some((key) => !keys.has(key))) throw new Error("答案包含不属于本次提问的字段");
  for (const q of request.questions) {
    const answer = answers[q.id];
    if (!answer || (!answer.text && !answer.selected.length)) throw new Error("请回答所有问题后再提交");
    if (new Set(answer.selected).size !== answer.selected.length) throw new Error("选项不可重复");
    if (!q.multiSelect && answer.selected.length > 1) throw new Error("此问题只能选择一个选项");
    if (answer.selected.some((id) => !q.options.some((o) => o.id === id))) throw new Error("答案包含无效选项");
    if (answer.text && q.options.length && !q.allowOther) throw new Error("此问题只能使用列出的选项");
  }
  return answers;
}
/** @param {z.infer<typeof agentQuestionSchema>} question @param {z.infer<typeof agentAnswerSchema>[string]} answer */
export function agentAnswerLabels(question, answer) {
  return [
    ...answer.selected.map((id) => question.options.find((o) => o.id === id)?.label || id),
    ...(answer.text ? [answer.text] : []),
  ];
}
export const agentItemKinds = ["message", "thinking", "tool", "command", "files", "plan", "notice", "question"];
export const agentPhaseSchema = z.enum(["running", "completed", "failed", "cancelled", "waiting"]);
export const agentItemEventSchema = z.object({
  type: z.literal("agent-item"),
  version: z.literal(1),
  id: identifier,
  kind: z.enum(["message", "thinking", "tool", "command", "files", "plan", "notice", "question"]),
  phase: agentPhaseSchema.optional(),
  at: z.number().finite().nonnegative(),
  text: z.string().optional(),
  delta: z.string().optional(),
  title: z.string().max(1000).optional(),
  command: z.string().max(16000).optional(),
  cwd: z.string().max(2000).optional(),
  output: z.string().max(128000).optional(),
  outputDelta: z.string().max(64000).optional(),
  error: z.string().max(16000).optional(),
  files: z.array(z.object({ path: z.string().max(2048), kind: z.string().max(30).optional(), diff: z.string().max(128000).optional(), added: z.number().nonnegative().optional(), removed: z.number().nonnegative().optional(), binary: z.boolean().optional(), truncated: z.boolean().optional(), note: z.string().max(4000).optional() }).passthrough()).max(100).optional(),
  steps: z.array(z.object({ id: z.string().max(200), text: z.string().max(2000), status: z.string().max(30) }).passthrough()).max(50).optional(),
}).passthrough();
