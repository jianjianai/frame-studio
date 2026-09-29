import type { z } from "zod";
import type { operationContracts, taskStateSchema, taskKindSchema, taskEventSchema, reviewContextSchema, playerStateSchema, previewMessageSchema, playerCommandSchema } from "./platform.mjs";
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskKind = z.infer<typeof taskKindSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export interface TaskSummary { id: string; state: TaskState }
export type ReviewContext = z.infer<typeof reviewContextSchema>;
export type PlayerState = z.infer<typeof playerStateSchema>;
export type PreviewMessage = z.infer<typeof previewMessageSchema>;
export type PlayerCommand = z.infer<typeof playerCommandSchema>;
export type OperationName = keyof typeof operationContracts;
export type OperationInput<N extends OperationName> = z.input<(typeof operationContracts)[N]["request"]>;
export type OperationResult<N extends OperationName> = z.output<(typeof operationContracts)[N]["response"]>;
