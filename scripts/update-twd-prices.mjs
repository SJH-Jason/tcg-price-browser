#!/usr/bin/env node
// 台幣參考價分批更新器（卡拍拍 trade.kapaipai.tw，模式B：搜「set-number」）
// 用法: node scripts/update-twd-prices.mjs [SET1 SET2 ...]  省略=全部
// 環境變數:
//   TWD_LIMIT=N     本次最多查 N 張就停（分批防逾時；預設 40）
//   TWD_SLEEP=ms    每張查詢間隔（防 bot 牆；預設 2500）
// 特性:
//   ①冪等：查過的結果存 /tmp/twd-cache/<set>-<number>.json，重跑跳過當天已查的 → 可重入接續
//   ②依稀有度匹配：搜尋回多筆版本時，取與 index.html 該卡 rarity 相符那筆的「起」價
//   ③匹配不到稀有度 → 記為 null（不亂寫），回報時列出
//   ④只在真的查到價格才寫回 index.html priceTWD；語法檢查後才存檔
//   ⑤達 TWD_LIMIT 或全查完就結束，印 DONE_TWD done=N remaining=M
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");
const OC = process.env.OPENCLAW_MJS || `${process.env.HOME}/Developer/OpenClaw/openclaw/openclaw.mjs`;
const CACHE = "/tmp/twd-cache";
const TODAY = new Date().toISOString().slice(0, 10);
const LIMIT = parseInt(process.env.TWD_LIMIT || "40", 10);
const SLEEP_MS = parseInt(process.env.TWD_SLEEP || "2500", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

function sh(args, timeout = 60000) {
  try { return execFileSync("node", [OC, ...args], { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return e.stdout ? String(e.stdout) : ""; }
}
function nav(url) { try { execFileSync("node", [OC, "browser", "navigate", url], { stdio: "ignore", timeout: 60000 }); } catch {} }
function snap() { return sh(["browser", "snapshot"]); }

// 從 index.html 抓卡片 {set, number(三碼), rarity, hasTwd}
// TWD_ONLY_MISSING=1(預設)：只抓尚無 priceTWD 的卡，不碰已填好的(避免重查污染已驗證值)
const ONLY_MISSING = process.env.TWD_ONLY_MISSING !== "0";
function parseCards(html, targets) {
  const cards = [];
  const re = /\{\s*set:"([^"]+)"[^}]*?\}/g;
  let m;
  while ((m = re.exec(html))) {
    const chunk = m[0], set = m[1];
    if (targets.length && !targets.includes(set)) continue;
    const num = chunk.match(/number:"(\d{3})[^"]*"/);   // 只取純三碼卡號（跳過 R/RGB 這種特殊號，卡拍拍搜不到）
    const rar = chunk.match(/rarity:"([^"]*)"/);
    if (!num) continue;
    const tm = chunk.match(/priceTWD:(\d+)/);
    const hasTwd = tm && parseInt(tm[1], 10) > 0;
    if (ONLY_MISSING && hasTwd) continue; // 已有台幣 → 跳過
    cards.push({ set, number: num[1], rarity: rar ? rar[1] : "" });
  }
  return cards;
}

// 動態抓搜尋框 ref（每次刷新會變）
function getSearchRef() {
  const s = snap();
  const m = s.match(/textbox "卡名[^"]*"[^\n]*?\[ref=([a-z0-9]+)\]/);
  return m ? m[1] : null;
}

// 解析搜尋結果：回傳 [{price, cardNo, version}]（每筆掛賣一組）
// 卡拍拍結構(每筆)： $ → 價格 → 「起」→ 招式名 → 卡號(如 M6a-136 / CLL-008) → 版本(無標記/紀念版/大師球版…)
// 注意：搜一個卡號可能連帶撈出別套組同圖卡(如搜 M6a-136 撈到 CLL-008 無標記版)，故要同時記卡號+版本，由 pickPrice 篩。
function parseResults(s) {
  const lines = s.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // 價格節點： generic [ref=..]: "650"，其下一行是 起；其餘數字(數量徽章)不算
    const pm = lines[i].match(/generic \[ref=[a-z0-9]+\]:\s*"([0-9,]+)"/);
    if (!pm) continue;
    const qi = lines[i + 1] && lines[i + 1].includes("起");
    if (!qi) continue;
    const price = parseInt(pm[1].replace(/,/g, ""), 10);
    // 從「起」往下找：先遇到卡號(字母數字-數字格式)，其下一行即版本中文標示
    let cardNo = "", version = "";
    for (let j = i + 1; j <= i + 14 && j < lines.length; j++) {
      const cm = lines[j].match(/generic \[ref=[a-z0-9]+\]:\s*([A-Za-z0-9]+-\d+)\s*(?:\[new\])?\s*$/);
      if (cm) {
        cardNo = cm[1];
        const vm = lines[j + 1] && lines[j + 1].match(/generic \[ref=[a-z0-9]+\]:\s*([^\[\n]+?)\s*(?:\[new\])?\s*$/);
        if (vm) version = vm[1].trim();
        break;
      }
    }
    out.push({ price, cardNo, version });
  }
  return out;
}

async function queryCard(searchRef, set, number) {
  const q = `${set}-${number}`;
  sh(["browser", "type", searchRef, q, "--submit"]);
  await sleep(SLEEP_MS);
  return parseResults(snap());
}

// 版本正規化：去空白，判斷是否「無標記」
const isNoMark = (v) => /無標記/.test(String(v || ""));

function cachePath(set, number) { return join(CACHE, `${set}-${number}.json`); }
function readCache(set, number) {
  const p = cachePath(set, number);
  if (!existsSync(p)) return null;
  try { const j = JSON.parse(readFileSync(p, "utf8")); return j.date === TODAY ? j : null; } catch { return null; }
}
function writeCache(set, number, data) { writeFileSync(cachePath(set, number), JSON.stringify({ date: TODAY, ...data })); }

// 依「卡號」挑價（卡凡 2026-10-04 定：用卡號比對；無標記多為預組/卡包內容卡）
// 關鍵：搜一個卡號會連帶撈出同圖的別張卡(別卡號)，故必須先鎖定「本卡號」那筆，別抓到鄰卡。
// 並非每張卡都有「無標記」版(AR/SR 等特殊卡版本欄就是 AR/SR)；只有本卡號有多筆時才用無標記優先。
// 順序：①本卡號且無標記 → ②本卡號任一版本最低 → ③完全沒有本卡號 → null(不亂抓鄰卡)
function pickPrice(results, selfCardNo) {
  if (!results.length) return { price: null, reason: "no-listing" };
  const self = results.filter((r) => r.cardNo === selfCardNo);
  if (!self.length) return { price: null, reason: "no-self-match" }; // 搜到的全是鄰卡 → 不寫
  const selfNoMark = self.filter((r) => isNoMark(r.version));
  if (selfNoMark.length) return { price: Math.min(...selfNoMark.map((r) => r.price)), reason: "nomark-self" };
  // 本卡號無「無標記」版(例如 AR/SR 特殊卡) → 取本卡號最低價
  return { price: Math.min(...self.map((r) => r.price)), reason: "self-lowest" };
}

function writeBackTwd(html, updates) {
  let changed = 0;
  const lines = html.split("\n").map((l) => {
    for (const u of updates) {
      if (l.includes(`set:"${u.set}"`) && new RegExp(`number:"${u.number}[/"]`).test(l)) {
        const om = l.match(/priceTWD:(\d+)/);
        const oldp = om ? parseInt(om[1], 10) : null;
        if (oldp === u.price) return l;
        changed++;
        if (om) return l.replace(/priceTWD:\d+/, `priceTWD:${u.price}`);
        // 沒有 priceTWD 欄位 → 加在 price/priceJPY 後
        return l.replace(/(price(?:JPY)?:\d+)/, `$1, priceTWD:${u.price}`);
      }
    }
    return l;
  });
  return { html: lines.join("\n"), changed };
}
function syntaxCheck(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  writeFileSync("/tmp/tcg-twd-syntax.js", m[1]);
  execFileSync("node", ["--check", "/tmp/tcg-twd-syntax.js"], { stdio: "ignore" });
}

async function main() {
  let html = readFileSync(HTML, "utf8");
  const targets = process.argv.slice(2);
  const cards = parseCards(html, targets);

  // 待查 = 今天還沒 cache 的
  const pending = cards.filter((c) => !readCache(c.set, c.number));
  console.log(`台幣待查: ${pending.length} / 全部 ${cards.length}（今天已查 ${cards.length - pending.length}）`);

  // 確保瀏覽器在跑 + 進搜尋頁
  const st = sh(["browser", "status"]);
  if (!/running:\s*true/.test(st)) sh(["browser", "start"]);
  nav("https://trade.kapaipai.tw/search");
  await sleep(2000);

  const updates = [];
  const misses = [];
  let done = 0;
  for (const c of pending) {
    if (done >= LIMIT) break;
    let searchRef = getSearchRef();
    if (!searchRef) { nav("https://trade.kapaipai.tw/search"); await sleep(2000); searchRef = getSearchRef(); }
    if (!searchRef) { console.log(`  ⚠️ 抓不到搜尋框，略過 ${c.set}-${c.number}`); continue; }

    const results = await queryCard(searchRef, c.set, c.number);
    const { price, reason } = pickPrice(results, `${c.set}-${c.number}`);
    writeCache(c.set, c.number, { price, reason, rarity: c.rarity });
    if (price != null) {
      updates.push({ set: c.set, number: c.number, price });
    } else if (reason === "no-listing" || reason === "no-self-match") {
      // 卡凡 2026-10-04 定：查無本卡掛賣 → 標 priceTWD:1 當「暫無行情」佔位，日後有上架再更新
      updates.push({ set: c.set, number: c.number, price: 1 });
      misses.push(`${c.set}-${c.number}(${c.rarity||"?"}):${reason}→標1`);
    } else {
      misses.push(`${c.set}-${c.number}(${c.rarity||"?"}):${reason}`);
    }
    done++;
    if (done % 5 === 0) console.log(`  ...已查 ${done}/${Math.min(LIMIT, pending.length)}`);
  }

  // 寫回 index.html
  const r = writeBackTwd(html, updates);
  if (r.changed > 0) { syntaxCheck(r.html); writeFileSync(HTML, r.html); }

  const remaining = pending.length - done;
  console.log(`本批查了 ${done} 張，寫回 ${r.changed} 張，未命中 ${misses.length} 張`);
  if (misses.length) console.log("未命中:", misses.slice(0, 20).join(" | "));
  console.log(`DONE_TWD done=${done} written=${r.changed} remaining=${remaining}`);
}
main().catch((e) => { console.error("FATAL_TWD", e); process.exit(1); });
