import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { useWorkbench } from "../workbench/store";
import { reviewsPath } from "../lib/reviews";

interface Table {
  sheets: { name: string; rows: string[][]; total: number }[];
}

const TABLE = /\.(xlsx|xlsm|csv|tsv)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/**
 * An original file of a work's review (`<work id>/raw/…`) as it was uploaded: spreadsheets
 * as tables (each sheet), screenshots as images, PDFs in the browser's viewer.
 */
export function RawViewer({ fileRef }: { fileRef: string }) {
  const { work, askAi } = useWorkbench();
  const [id, ...rest] = fileRef.split("/");
  const file = rest.join("/");
  const url = `${reviewsPath(work.repo)}/works/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(file)}`;
  const [table, setTable] = useState<Table | null>(null);
  const [sheet, setSheet] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    setTable(null);
    setError("");
    setSheet(0);
    if (TABLE.test(file)) void api<Table>(`${url}&table=1`).then(setTable, (failure: Error) => setError(failure.message));
  }, [url, file]);
  const shown = table?.sheets[sheet];
  const width = Math.max(0, ...(shown?.rows.map((row) => row.length) ?? []));
  return (
    <>
      <div className="editor-toolbar">
        <span className="faint small-text ellipsis grow" title={file}>
          复盘原始文件 · {file}
          {shown && ` · ${shown.total} 行`}
        </span>
        {table && table.sheets.length > 1 && (
          <div className="segmented">
            {table.sheets.map((item, index) => (
              <button key={item.name} className={index === sheet ? "active" : ""} onClick={() => setSheet(index)}>
                {item.name}
              </button>
            ))}
          </div>
        )}
        {id === work.id && (
          <button
            className="btn small"
            onClick={() => askAi(`请读取复盘原始文件 ${file}，把里面的数据用 review_write 录入（source 写这个文件）。看不清或拿不准的数字先问我，不要猜。`)}
          >
            <Sparkles size={13} /> 让 AI 录入
          </button>
        )}
        <a className="btn small" href={url} download={file.split("/").pop()}>
          <Download size={13} /> 下载
        </a>
      </div>
      {TABLE.test(file) ? (
        error ? (
          <div className="empty">{error}</div>
        ) : !shown ? (
          <div className="empty">正在读取…</div>
        ) : (
          <div className="raw-table-wrap">
            <table className="raw-table">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: width }, (_, index) => (
                    <th key={index}>{columnName(index)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.rows.map((row, index) => (
                  <tr key={index}>
                    <th>{index + 1}</th>
                    {Array.from({ length: width }, (_, column) => (
                      <td key={column} title={row[column] ?? ""}>
                        {row[column] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.total > shown.rows.length && <div className="faint small-text">只显示了前 {shown.rows.length} 行</div>}
          </div>
        )
      ) : IMAGE.test(file) ? (
        <div className="media-viewer">
          <img src={url} alt={file} />
        </div>
      ) : /\.pdf$/i.test(file) ? (
        <iframe className="raw-pdf" src={url} title={file} />
      ) : (
        <div className="empty">这种文件不能在这里预览，可以下载后查看</div>
      )}
    </>
  );
}

/** 0 → A, 26 → AA, like the spreadsheet's own column names. */
const columnName = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : columnName(Math.floor(index / 26) - 1) + columnName(index % 26));
