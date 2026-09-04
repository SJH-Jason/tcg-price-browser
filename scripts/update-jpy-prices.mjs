#!/usr/bin/env node
// 全套日幣現貨價 re-scrape 更新器（hareruya2 晴れる屋2）
// 用法: node scripts/update-jpy-prices.mjs [SET1 SET2 ...]  省略=全部19套
// 特性: ①從 index.html 的 SETS map 讀日文名(不寫死) ②提早終止(本頁最低<¥500就停)
//       ③版本感知寫回(エラー版共卡號不互相蓋) ④sold-out 保留舊價、不動 updated
//       ⑤只在 price 真的變動才改 updated ⑥語法檢查
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");
const OC = process.env.OPENCLAW_MJS || `${process.env.HOME}/Developer/OpenClaw/openclaw/openclaw.mjs`;
const TODAY = new Date().toISOString().slice(0, 10);
const MIN_YEN = 500;      // 收錄門檻
const MAX_PAGES = 6;      // 上限;提早終止通常用不到
const SLEEP_MS = 1500;    // snapshot 間隔

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadHtml() { return readFileSync(HTML, "utf8"); }
function getSets(html) {
  const m = html.match(/const SETS\s*=\s*(\{[\s\S]*?\});/);
  return eval("(" + m[1] + ")");
}

function browserNav(url) {
  try { execFileSync("node", [OC, "browser", "navigate", url], { stdio: "ignore", timeout: 60000 }); }
  catch { /* 導頁偶爾 timeout,靠下一次 snapshot 補 */ }
}
function browserSnapshot() {
  try { return execFileSync("node", [OC, "browser", "snapshot"], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return e.stdout ? String(e.stdout) : ""; }
}

// 從單頁 snapshot 文字抽 { "NNN|N"/"NNN|E": [prices] } 並回報本頁最低價
function parseSnap(snap, set, acc) {
  const lines = snap.split("\n");
  let pageLowest = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(/heading "([^"]*)〈(\d{3})\/\d{3}〉\[([A-Za-z0-9]+)\]"/);
    if (!hm) continue;
    const [, nameFull, num, s] = hm;
    if (s !== set) continue;
    const isError = /エラー版/.test(nameFull);
    let price = null;
    for (let j = i + 1; j <= i + 6 && j < lines.length; j++) {
      const pm = lines[j].match(/generic \[ref=[a-z0-9]+\]:\s*¥([0-9,]+)/);
      if (pm) { price = parseInt(pm[1].replace(/,/g, ""), 10); break; }
    }
    if (price == null) continue;
    const key = num + (isError ? "|E" : "|N");
    (acc[key] = acc[key] || []).push(price);
    if (price < pageLowest) pageLowest = price;
  }
  return pageLowest;
}

async function fetchSet(jp, set) {
  const acc = {};
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `https://www.hareruya2.com/search?q=${encodeURIComponent(jp)}&sort_by=price-descending&page=${p}`;
    browserNav(url);
    await sleep(SLEEP_MS);
    const snap = browserSnapshot();
    const lowest = parseSnap(snap, set, acc);
    // 提早終止:本頁已排到 <¥500(price-descending,所以低價在後面頁)
    if (lowest < MIN_YEN) break;
    if (lowest === Infinity) break; // 本頁沒抓到此套任何卡,再翻也沒用
  }
  const map = {};
  for (const k in acc) map[k] = Math.max(...acc[k]); // 首筆=現價,取最高代表
  return map;
}

// 版本感知寫回:row 依 nameJp 是否含エラー版對到 |E/|N
function writeBack(html, set, fresh) {
  let changed = 0, unchanged = 0, keep = 0;
  const lines = html.split("\n").map((l) => {
    if (!l.includes(`set:"${set}"`)) return l;
    const nm = l.match(/number:"(\d{3})\/\d{3}"/);
    if (!nm) return l;
    const key = nm[1] + (/エラー版/.test(l) ? "|E" : "|N");
    if (!(key in fresh)) { keep++; return l; } // sold-out / 沒抓到 → 保留
    const newp = fresh[key];
    const om = l.match(/price:(\d+)/);
    const oldp = om ? parseInt(om[1], 10) : null;
    if (oldp === newp) { unchanged++; return l; }
    changed++;
    return l.replace(/price:\d+/, "price:" + newp).replace(/updated:"[^"]*"/, `updated:"${TODAY}"`);
  });
  return { html: lines.join("\n"), changed, unchanged, keep };
}

function syntaxCheck(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const tmp = "/tmp/tcg-syntax-check.js";
  writeFileSync(tmp, m[1]);
  execFileSync("node", ["--check", tmp], { stdio: "ignore" });
}

async function main() {
  let html = loadHtml();
  const SETS = getSets(html);
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SETS);
  const summary = [];
  for (const set of targets) {
    if (!SETS[set]) { console.log(`skip ${set}: not in SETS`); continue; }
    const fresh = await fetchSet(SETS[set].nameJp, set);
    const r = writeBack(html, set, fresh);
    html = r.html;
    summary.push(`${set}: changed=${r.changed} unchanged=${r.unchanged} keep(sold-out)=${r.keep} keys=${Object.keys(fresh).length}`);
    console.log(summary[summary.length - 1]);
  }
  syntaxCheck(html);
  writeFileSync(HTML, html);
  const total = summary.reduce((n, s) => n + parseInt(s.match(/changed=(\d+)/)[1], 10), 0);
  console.log(`DONE total_changed=${total}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
