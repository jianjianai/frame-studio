import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { problem } from "./util.mjs";

/**
 * Spreadsheets downloaded from video platforms' creator centers (xlsx, csv, tsv), read as
 * tables of text so that people and the AI can take the numbers out of them. Only what such
 * exports use: values, shared and inline strings, dates and percentages from the number
 * format. Formulas are not evaluated; their saved result is read.
 */
export const TABLE_FILE = /\.(xlsx|xlsm|csv|tsv)$/i;
const PART_LIMIT = 64 * 1024 * 1024; // one unpacked xlsx part (a sheet), against zip bombs

/** { sheets: [{ name, rows: string[][], total }] }, at most `maxRows` rows per sheet. */
export function readTable(file, { maxRows = 5000 } = {}) {
  const buffer = fs.readFileSync(file);
  const sheets = /\.(xlsx|xlsm)$/i.test(file)
    ? readXlsx(buffer)
    : [{ name: path.basename(file), rows: parseDelimited(decodeText(buffer), /\.tsv$/i.test(file) ? "\t" : null) }];
  return { sheets: sheets.map(({ name, rows }) => ({ name, rows: rows.slice(0, maxRows), total: rows.length })) };
}

/** The table as the AI reads it: CSV per sheet, empty rows left out, long sheets cut. */
export function tableText({ sheets }, { maxRows = 400, maxChars = 200_000 } = {}) {
  const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  let budget = maxChars;
  const parts = [];
  for (const sheet of sheets) {
    const rows = sheet.rows.filter((row) => row.some((cell) => cell !== ""));
    const lines = [];
    for (const row of rows.slice(0, maxRows)) {
      const line = row.map(quote).join(",");
      if (line.length > budget) break;
      budget -= line.length + 1;
      lines.push(line);
    }
    const cut = rows.length - lines.length + (sheet.total - sheet.rows.length);
    parts.push(`=== 工作表「${sheet.name}」（${sheet.total} 行${cut > 0 ? `，只显示了前 ${lines.length} 行` : ""}）\n${lines.join("\n")}`);
    if (budget <= 0) break;
  }
  return parts.join("\n\n");
}

// ---- csv / tsv -------------------------------------------------------------------------

/** UTF-8 (with or without BOM), UTF-16 with BOM (Excel's "Unicode text"), else GB18030 (older Chinese exports). */
export function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}

/** RFC 4180 fields (quotes, doubled quotes, line breaks in quotes); the delimiter is guessed from the first line when not given. */
export function parseDelimited(text, delimiter = null) {
  if (!delimiter) {
    const first = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
    const counts = [",", "\t", ";"].map((mark) => [mark, first.split(mark).length]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  return rows.map(trimRow);
}

const trimRow = (row) => {
  let end = row.length;
  while (end && row[end - 1].trim() === "") end--;
  return row.slice(0, end).map((cell) => cell.trim());
};

// ---- xlsx ------------------------------------------------------------------------------

const decodeXml = (text) =>
  text
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name) =>
      name[0] === "#"
        ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
        : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name.toLowerCase()],
    )
    // OOXML writes control characters as _xHHHH_.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const attributes = (text) =>
  Object.fromEntries([...text.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(([, key, value]) => [key.replace(/^\w+:/, ""), decodeXml(value)]));

/** The text of an <si> or <is>: its <t> runs, without phonetic guides. */
const runsText = (xml) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((match) => decodeXml(match[1] ?? "")).join("");

// Number formats that show dates or times (built-in ids, including the CJK date formats).
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const PERCENT_FORMATS = new Set([9, 10]);

function readXlsx(buffer) {
  let parts;
  try {
    parts = unzipSync(new Uint8Array(buffer), {
      filter: (entry) => entry.originalSize <= PART_LIMIT && /^(xl\/.*\.xml|xl\/_rels\/workbook\.xml\.rels)$/.test(entry.name),
    });
  } catch (error) {
    throw problem(422, `无法读取这个表格文件：${error.message}`);
  }
  const text = (name) => (parts[name] ? strFromU8(parts[name]) : "");
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw problem(422, "这不是 xlsx 表格（缺少 xl/workbook.xml）");
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const targets = Object.fromEntries(
    [...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)].map(([, attrs]) => {
      const { Id, Target } = attributes(attrs);
      return [Id, Target.startsWith("/") ? Target.slice(1) : `xl/${Target}`];
    }),
  );
  const strings = [...text("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((match) => runsText(match[1] ?? ""));

  // Style index → how its numbers read (date, percent or plain).
  const styles = text("xl/styles.xml");
  const custom = Object.fromEntries(
    [...styles.matchAll(/<numFmt\b([^>]*)\/?>/g)].map(([, attrs]) => attributes(attrs)).map((item) => [Number(item.numFmtId), item.formatCode || ""]),
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const kinds = [...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map(([, attrs]) => {
    const id = Number(attributes(attrs).numFmtId || 0);
    const code = (custom[id] ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
    if (DATE_FORMATS.has(id) || (custom[id] && /[ymdhs]/i.test(code) && !/^general$/i.test(code))) return "date";
    if (PERCENT_FORMATS.has(id) || code.includes("%")) return "percent";
    return "number";
  });

  const sheets = [];
  for (const [, attrs] of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const { name, id } = attributes(attrs);
    const xml = text(targets[id] ?? "");
    if (!xml) continue;
    const rows = [];
    for (const [, rowAttrs, body = ""] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const at = Number(attributes(rowAttrs).r) - 1;
      // Rows the file leaves out (empty) keep their place, up to a point.
      while (Number.isInteger(at) && rows.length < at && at - rows.length < 1000) rows.push([]);
      const row = [];
      for (const [, cellAttrs, inner = ""] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cell = attributes(cellAttrs);
        const column = cell.r ? columnIndex(cell.r) : row.length;
        if (column > 16383) continue;
        while (row.length < column) row.push("");
        row[column] = cellValue(cell, inner, strings, kinds, date1904);
      }
      rows.push(trimRow(row));
    }
    while (rows.length && !rows.at(-1).length) rows.pop();
    sheets.push({ name: name || `Sheet${sheets.length + 1}`, rows });
  }
  return sheets;
}

/** "AB12" → 27 (zero-based column). */
const columnIndex = (ref) => [...(/^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A")].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;

function cellValue(cell, inner, strings, kinds, date1904) {
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (cell.t === "inlineStr") return runsText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
  if (raw === undefined) return "";
  const value = decodeXml(raw);
  if (cell.t === "s") return strings[Number(value)] ?? "";
  if (cell.t === "b") return value === "1" ? "TRUE" : "FALSE";
  if (cell.t === "str" || cell.t === "e" || cell.t === "d") return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const kind = kinds[Number(cell.s || 0)] ?? "number";
  if (kind === "date") return excelDate(number, date1904);
  if (kind === "percent") return `${plain(number * 100)}%`;
  return plain(number);
}

/** Without binary noise (0.1 + 0.2), and without exponents for ordinary numbers. */
const plain = (number) => String(Number(number.toPrecision(15)));

/** A serial date as Excel shows it (no time zone): "2026-10-08", "2026-10-08 20:00", or a duration "00:00:09". */
export function excelDate(serial, date1904 = false) {
  const days = date1904 ? serial + 1462 : serial;
  // Whole seconds, as Excel shows them (a stored 8.99 s reads 00:00:09).
  const ms = Math.round((days - 25569) * 86400) * 1000;
  const date = new Date(ms);
  if (Number.isNaN(ms)) return String(serial);
  const iso = date.toISOString();
  const time = iso.slice(11, 19);
  if (serial >= 0 && serial < 1) return time;
  if (time === "00:00:00") return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${time.endsWith(":00") ? time.slice(0, 5) : time}`;
}
