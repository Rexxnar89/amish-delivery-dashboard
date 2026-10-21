// Weekly/daily live price check via SerpApi (free plan). Writes prices.json and price-changes.json.
import fs from "node:fs";
const KEY = process.env.SERPAPI_KEY;
if (!KEY) { console.error("SERPAPI_KEY missing"); process.exit(1); }
const MONTH_BUDGET = +(process.env.MONTH_BUDGET || 230);
const FORCE_FULL = process.env.FULL === "true";
const cat = JSON.parse(fs.readFileSync("products.json", "utf8"));
const prev = fs.existsSync("prices.json") ? JSON.parse(fs.readFileSync("prices.json", "utf8")) : { items: {} };
const DEFAULT_DAILY = ["All-Purpose Flour 25 lb","Granulated Sugar 25 lb","Rolled Oats 10 lb","Chicken Layer Feed 50 lb","Laundry Detergent 200 loads","Toilet Paper 30 rolls","Lamp Oil 1 gal","Dish Soap 90 oz"];
const SELLERS = { "walmart":"Walmart","target":"Target","amazon.com":"Amazon","amazon":"Amazon","sam's club":"Sam's Club","sams club":"Sam's Club","tractor supply co.":"Tractor Supply","tractor supply":"Tractor Supply","lehman's":"Lehman's","lehmans":"Lehman's" };
const now = new Date();
const etDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
const isMonday = etDay === "Mon" || FORCE_FULL;
let used = 0;
async function serp(params) {
  const u = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries({ ...params, api_key: KEY })) u.searchParams.set(k, v);
  const r = await fetch(u); const j = await r.json(); used++;
  if (j.error) throw new Error(j.error); return j;
}
async function account() { try { const r = await fetch("https://serpapi.com/account?api_key=" + KEY); return await r.json(); } catch { return {}; } }
async function ownerConfig() { // public-read Firestore doc config/settings (owner's Daily list and bad-match flags)
  try { const r = await fetch("https://firestore.googleapis.com/v1/projects/amish-delivery/databases/(default)/documents/config/settings");
    if (!r.ok) return {}; const f = (await r.json()).fields || {};
    const daily = (f.priceDaily?.arrayValue?.values || []).map(v => v.stringValue).filter(Boolean);
    const flags = Object.keys(f.priceFlags?.mapValue?.fields || {}).filter(k => f.priceFlags.mapValue.fields[k].booleanValue);
    return { daily, flags }; } catch { return {}; }
}
const toks = s => String(s).toLowerCase().replace(/[^a-z0-9.\s-]/g, " ").split(/[\s-]+/).filter(t => t && !["the","and","of","for","with","a"].includes(t));
const nums = s => (String(s).toLowerCase().match(/\d+(\.\d+)?/g) || []);
function score(name, title) {
  const a = toks(name), b = new Set(toks(title)); const hit = a.filter(t => b.has(t)).length / a.length;
  const tn = nums(title), miss = nums(name).filter(n => !tn.includes(n)).length; // sizes must match
  const pack = /pack of \d+|\(\d+\s*pack\)|\d+\s*-?\s*pack|case of/i.test(title) && !/pack|count/i.test(name) ? 0.5 : 0;
  const acc = /\b(kit|replacement|refill|parts?|accessor(y|ies)|attachment|motorization|cover|case)\b/i.test(title) && !/\b(kit|refill)\b/i.test(name) ? 0.5 : 0;
  return Math.max(0, hit - 0.35 * miss - pack - acc);
}
function sellerOf(src) { const s = String(src || "").toLowerCase().trim(); return SELLERS[s] || null; } // first-party sellers only (not "Walmart - X" marketplace)
if (process.env.RESCORE) { const pj = JSON.parse(fs.readFileSync("prices.json","utf8")); for (const [k,v] of Object.entries(pj.items)) { v.score = +score(v.item, v.matchedTitle).toFixed(2); if (v.score < 0.6) delete pj.items[k]; } fs.writeFileSync("prices.json", JSON.stringify(pj,null,1)); console.log("rescored", Object.keys(pj.items).length); process.exit(0); }
const acct0 = await account();
const usedThisMonth = +acct0.this_month_usage || 0;
const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), dayOfMonth = +new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",day:"numeric"}).format(now);
let mondaysLeft = 0; for (let d = dayOfMonth + 1; d <= dim; d++) if (new Date(now.getFullYear(), now.getMonth(), d).getDay() === 1) mondaysLeft++;
const daysLeft = dim - dayOfMonth; // future runs after today
const cfg = await ownerConfig();
const dailyNames = (cfg.daily && cfg.daily.length ? cfg.daily : DEFAULT_DAILY).slice(0, 8);
const others = cat.products.filter(p => !dailyNames.includes(p.name)).length;
const reserve = mondaysLeft * others + daysLeft * Math.min(8, dailyNames.length) * 0; // daily items are trimmed below
const left = Math.max(0, MONTH_BUDGET - usedThisMonth);
// budget: keep enough for remaining Mondays, spread the rest over remaining days
const futureMondayCost = mondaysLeft * others;
const perDay = Math.max(0, Math.floor((left - (isMonday ? others : 0) - futureMondayCost) / (daysLeft + 1)));
let dailyToday = dailyNames.slice(0, Math.min(dailyNames.length, perDay));
let todo = cat.products.filter(p => dailyToday.includes(p.name));
if (isMonday) todo = todo.concat(cat.products.filter(p => !dailyNames.includes(p.name)));
if (todo.length > left) todo = todo.slice(0, left);
console.log(`ET day ${etDay}; monday=${isMonday}; used this month before run=${usedThisMonth}; budget left=${left}; daily allowed today=${dailyToday.length}/${dailyNames.length}; checking ${todo.length} products`);
const items = { ...(prev.items || {}) }, changes = { generatedAt: now.toISOString(), jumps: [], outOfStock: [], missing: [], errors: [] };
const checkedAt = now.toISOString();
for (const p of todo) {
  let res;
  try { res = await serp({ engine: "google_shopping", q: p.query || p.name, location: cat.location, gl: "us", hl: "en" }); }
  catch (e) { changes.errors.push({ item: p.name, error: e.message }); continue; }
  const best = {};
  for (const r of res.shopping_results || []) {
    const st = sellerOf(r.source); if (!st || r.extracted_price == null) continue;
    const sc = Math.max(score(p.name, r.title), p.query && p.query !== p.name ? score(p.query, r.title) : 0); if (sc < 0.6) continue;
    if (!best[st] || sc > best[st].score || (sc === best[st].score && r.extracted_price < best[st].price))
      best[st] = { item: p.name, store: st, price: r.extracted_price, inStock: null, link: r.product_link || r.link || "", matchedTitle: r.title, source: r.source, score: +sc.toFixed(2), via: "google_shopping", checkedAt };
  }
  for (const st of Object.keys(p.samplePrices)) {
    const key = p.name + "|" + st, old = prev.items?.[key], nw = best[st];
    if (nw) {
      if (old && old.price && Math.abs(nw.price - old.price) / old.price > 0.15) changes.jumps.push({ item: p.name, store: st, from: old.price, to: nw.price, pct: Math.round((nw.price - old.price) / old.price * 100) });
      if (old && old.inStock === true && nw.inStock === false) changes.outOfStock.push({ item: p.name, store: st });
      items[key] = nw;
    } else { changes.missing.push({ item: p.name, store: st }); if (old) items[key] = { ...old, stale: true }; }
  }
  for (const st of Object.keys(best)) if (!(st in p.samplePrices)) items[p.name + "|" + st] = { ...best[st], extraStore: true };
}
const acct1 = await account();
const out = { generatedAt: checkedAt, location: cat.location, zip: cat.zip, run: { monday: isMonday, productsChecked: todo.length, searchesUsedThisRun: used, monthUsageAfter: acct1.this_month_usage ?? null, monthBudget: MONTH_BUDGET, dailyList: dailyNames, dailyCheckedToday: dailyToday }, flaggedByOwner: cfg.flags || [], items };
fs.writeFileSync("prices.json", JSON.stringify(out, null, 1));
fs.writeFileSync("price-changes.json", JSON.stringify(changes, null, 1));
console.log(`done: ${used} searches; ${Object.values(items).filter(i => i.checkedAt === checkedAt).length} store prices updated; missing ${changes.missing.length}; jumps ${changes.jumps.length}`);
