import { z } from "zod";

export const operationErrorSchema = z.looseObject({
  error: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  recovery: z.string().max(100),
  retryable: z.boolean(),
  requestId: z.string().max(100).optional(),
});
/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) =>
  value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
/** One public error shape; database, filesystem and upstream internals are never exposed by a 500. @param {unknown} error @param {string} [requestId] */
export function operationError(error, requestId) {
  const value = record(error);
  const rawStatus = value.name === "ZodError" ? 400 : value.statusCode;
  const status =
    typeof rawStatus === "number" && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : 500;
  // Only explicitly sanitized, locally authored failures may expose a 5xx message.
  const safe = status < 500 || value.expose === true;
  const defaults =
    status === 401
      ? ["AUTH_REQUIRED", "sign-in"]
      : status === 409
        ? ["STATE_CONFLICT", "refresh-status"]
        : status === 400
          ? ["INVALID_REQUEST", "correct-input"]
          : ["OPERATION_FAILED", "check-status"];
  return {
    error:
      safe && typeof value.message === "string"
        ? value.message.slice(0, 6000)
        : "操作未完成，请检查最新状态后重试",
    status,
    code:
      safe &&
      typeof value.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,79}$/.test(value.code)
        ? value.code
        : defaults[0],
    recovery:
      safe && typeof value.recovery === "string"
        ? value.recovery.slice(0, 100)
        : defaults[1],
    retryable: safe && value.retryable === true,
    ...(typeof requestId === "string"
      ? { requestId: requestId.slice(0, 100) }
      : {}),
  };
}
/** @param {unknown} value */
export function clientOperationError(value) {
  const parsed = operationErrorSchema.safeParse(value);
  if (parsed.success)
    return Object.assign(new Error(parsed.data.error), parsed.data);
  const old = record(value);
  return Object.assign(
    new Error(
      typeof old.error === "string"
        ? old.error
        : "操作响应无效，请检查最新状态",
    ),
    {
      status: old.status,
      code: "OPERATION_UNCERTAIN",
      recovery: "check-status",
      retryable: false,
    },
  );
}
/** @param {string} message */
export const uncertainOperation = (message) =>
  Object.assign(new Error(message), {
    code: "OPERATION_UNCERTAIN",
    recovery: "check-status",
    retryable: false,
  });
