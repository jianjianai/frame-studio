// Status-only projections must not transfer frozen build inputs to the API.
const columns =
  "id,repo,project,kind,state,error,created,started,finished,expires,cleaned,source_commit,progress";
export const TASK_SUMMARY_COLUMNS = columns + ",result - 'input' AS result";
export const taskSummaryColumns = (db) =>
  db.kind === "sqlite"
    ? columns + ",json_remove(result,'$.input') AS result"
    : TASK_SUMMARY_COLUMNS;
export const taskEventColumns = (db) =>
  "id,kind,CASE WHEN kind='result' THEN " +
  (db.kind === "sqlite" ? "json_remove(data,'$.input')" : "data - 'input'") +
  " ELSE data END AS data,created";
