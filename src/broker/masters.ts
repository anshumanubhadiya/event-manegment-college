/**
 * masters.ts — broker instrument master files ka cache + lookup.
 *
 * Zerodha/Fyers ko master ki zarurat nahi (symbol khud ban jaata hai).
 * Angel/Upstox/Dhan ko token/key chahiye — wo in bade files se aate hain:
 *   Angel  : master.json (30 MB+)
 *   Upstox : complete.json.gz
 *   Dhan   : api-scrip-master.csv
 *
 * File ek baar download hoti hai, data/masters/ me cache hoti hai (gitignored).
 * Naya weekly contract aane pe file purani ho jaati hai — isliye `refresh` option.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { config } from "../config.ts";

export function masterPath(filename: string): string {
  return resolve(process.cwd(), config.dataDir, "masters", filename);
}

export async function cachedDownload(url: string, filename: string, opts: { gzip?: boolean; refresh?: boolean } = {}): Promise<string> {
  const file = masterPath(filename);
  if (existsSync(file) && !opts.refresh) return readFileSync(file, "utf8");
  console.log(`[masters] ${filename} download ho raha hai...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`master download fail (${url}): HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = opts.gzip ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  mkdirSync(resolve(process.cwd(), config.dataDir, "masters"), { recursive: true });
  writeFileSync(file, text);
  return text;
}

/** Simple CSV parser (quotes ke andar comma handle karta hai). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1) rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.length > 1) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
