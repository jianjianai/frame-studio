export function errorRecovery(error) {
  const code = error.name === "ZodError" || /^ERR_PARSE_ARGS/.test(error.code ?? "") ? "INVALID_ARGUMENTS" : error.code || "OPERATION_FAILED";
  const nextAction = error.nextAction ?? ({
    HASH_MISMATCH: "Re-read the current full-file SHA-256, reconcile changes, then submit a new edit.",
    VERSION_CONFLICT: "Re-read the current full-file SHA-256 or document revision; reconcile changes before editing.",
    CONFLICT: "Re-read the document and revision; reconcile changes before editing.",
    PROJECT_BUSY: "Query the active operation, wait, or cancel only your own job before retrying.",
    INVALID_ARGUMENTS: "Read the exact command/tool schema and correct the request.",
    INVALID_JSON: "Use a JSON file or stdin; do not put credentials in arguments.",
    ENOENT: "Read project context and list files to check the project and path.",
  }[code] ?? "Read command/tool help and the current project context before retrying.");
  return { code, message: error.message, ...(error.details ? { details: error.details } : {}), nextAction };
}
