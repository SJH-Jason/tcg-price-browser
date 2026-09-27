#!/usr/bin/env node
// 價格歷史快照器：讀 index.html 現有 priceJPY/priceTWD，把當天價格 append 進
//   price-history/<set>/<number>.csv（每張卡一檔）。
// 用法: node scripts/snapshot-history.mjs [SET1 SET2 ...]  省略=全部
// 特性:
//   ①每張卡 CSV 欄位: date,priceJPY,priceTWD,source
//   ②向下相容舊格式(date,price,source,sample_count)：舊 price 視為 priceJPY，讀得回、續寫新格式
//   ③同一天重跑會覆蓋當天那筆(不會重複 append)，可安全多次執行
//   ④priceJPY/priceTWD 為 0 或缺 → 該欄留空(不是寫 0)，避免污染趨勢圖
//   ⑤錯版共卡號: number 已含 /，用 set + number 當 key；錯版卡號相同時檔名加 -E 區分
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");
const HIST = join(ROOT, "price-history");
const TODAY = new Date().toISOString().slice(0, 10);
const HEADER = "date,priceJPY,priceTWD,source";

// number 可能含 "/"（如 113/076、R/RGB）→ 檔名用只取斜線前段的卡號、非法字元換成 _
function safeName(number, isError) {
  const base = String(number).split("/")[0].replace(/[^A-Za-z0-9]/g, "_");
  return base + (isError ? "-E" : "") + ".csv";
}

// 解析 index.html 的卡片 row（容忍欄位順序/空白差異）
function parseRows(html) {
  const rows = [];
  const re = /\{\s*set:"([^"]+)"[^}]*?\}/g;
  let m;
  while ((m = re.exec(html))) {
    const chunk = m[0];
    const set = m[1];
    const num = chunk.match(/number:"([^"]+)"/);
    if (!num) continue;
    // 日幣欄位在 index.html 有兩種命名混用：priceJPY: 或舊的 price:（兩者都是日幣現貨價）
    const jpy = chunk.match(/priceJPY:(\d+)/) || chunk.match(/(?:^|[,{\s])price:(\d+)/);
    const twd = chunk.match(/priceTWD:(\d+)/);
    const isError = /エラー版|エラー/.test(chunk);
    rows.push({
      set,
      number: num[1],
      priceJPY: jpy ? parseInt(jpy[1], 10) : 0,
      priceTWD: twd ? parseInt(twd[1], 10) : 0,
      isError,
    });
  }
  return rows;
}

// 讀既有 CSV → 回傳 {header, lines[]}（lines 不含 header），相容舊格式
function readCsv(path) {
  if (!existsSync(path)) return { rows: [] };
  const txt = readFileSync(path, "utf8").trim();
  if (!txt) return { rows: [] };
  const lines = txt.split("\n");
  const head = lines[0];
  const body = lines.slice(1).filter((l) => l.trim());
  const oldFormat = head.startsWith("date,price,source"); // 舊: date,price,source,sample_count
  const rows = body.map((l) => {
    const c = l.split(",");
    if (oldFormat) {
      // date, price(=JPY), source, sample_count → 轉新欄位（台幣未知留空）
      return { date: c[0], priceJPY: c[1] || "", priceTWD: "", source: c[2] || "" };
    }
    // 新格式 date,priceJPY,priceTWD,source
    return { date: c[0], priceJPY: c[1] || "", priceTWD: c[2] || "", source: c[3] || "" };
  });
  return { rows };
}

function main() {
  const html = readFileSync(HTML, "utf8");
  const all = parseRows(html);
  const targets = process.argv.slice(2);
  const rows = targets.length ? all.filter((r) => targets.includes(r.set)) : all;

  let appended = 0, updated = 0, skipped = 0;
  const touchedSets = new Set();

  for (const r of rows) {
    // 兩個價格都沒有 → 這張卡今天沒有可記錄的數字，跳過
    if (!r.priceJPY && !r.priceTWD) { skipped++; continue; }

    const dir = join(HIST, r.set);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName(r.number, r.isError));

    const { rows: hist } = readCsv(path);
    const jpyStr = r.priceJPY ? String(r.priceJPY) : "";
    const twdStr = r.priceTWD ? String(r.priceTWD) : "";
    const source = "hareruya2+kapaipai";

    const existingToday = hist.find((h) => h.date === TODAY);
    if (existingToday) {
      // 同一天重跑：覆蓋當天那筆（只在真的有變才算 updated）
      if (existingToday.priceJPY !== jpyStr || existingToday.priceTWD !== twdStr) {
        existingToday.priceJPY = jpyStr;
        existingToday.priceTWD = twdStr;
        existingToday.source = source;
        updated++;
      } else {
        skipped++;
        continue;
      }
    } else {
      hist.push({ date: TODAY, priceJPY: jpyStr, priceTWD: twdStr, source });
      appended++;
    }

    // 依日期排序後寫回（新格式）
    hist.sort((a, b) => a.date.localeCompare(b.date));
    const out = [HEADER, ...hist.map((h) => `${h.date},${h.priceJPY},${h.priceTWD},${h.source}`)].join("\n") + "\n";
    writeFileSync(path, out);
    touchedSets.add(r.set);
  }

  console.log(`SNAPSHOT ${TODAY}: appended=${appended} updated=${updated} skipped=${skipped} sets=${touchedSets.size}`);
  console.log(`DONE_HISTORY appended=${appended}`);
}
main();
