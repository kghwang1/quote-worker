/**
 * 리서치보드 시세 중계 서버 (Cloudflare Workers) — 야후 파이낸스 버전
 * ---------------------------------------------------------------
 * 야후 파이낸스에서 지수/원자재/환율 시세를 읽어와
 * 앱(브라우저)에 CORS 허용 헤더와 함께 JSON으로 돌려줍니다.
 *
 * 배포 후 사용 예:
 *   https://내주소.workers.dev/?symbol=^KS11       (코스피)
 *   https://내주소.workers.dev/?symbol=^KQ11       (코스닥)
 *   https://내주소.workers.dev/?symbol=^GSPC       (S&P500)
 *   https://내주소.workers.dev/?symbol=GC=F        (금)
 *
 * 여러 개 한 번에:
 *   https://내주소.workers.dev/?symbols=^KS11,^KQ11,^GSPC
 *
 * 응답 예(단일):
 *   {"ok":true,"symbol":"^KS11","name":"KOSPI","price":8801.49,
 *    "change":13.11,"rate":0.15}
 * 응답 예(복수): {"ok":true,"items":[ {...}, {...} ]}
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    // 공유 자료 저장/불러오기 (Cloudflare KV)
    const dataKey = url.searchParams.get("data");
    if (dataKey) return await handleData(request, env, dataKey);
    // 티커 → 네이버 월드스톡 페이지 주소 변환 (예: QQQ → worldstock/etf/QQQ.O/total)
    const nvlink = url.searchParams.get("nvlink");
    if (nvlink) return json(await naverWorldUrl(nvlink, url.searchParams.get("raw")), 200);
    const multi = url.searchParams.get("symbols");
    if (multi) {
      const syms = multi.split(",").map(s => s.trim()).filter(Boolean);
      // 종목을 병렬로 동시 조회 (순차 대비 훨씬 빠름 — 주식 탭처럼 종목이 많을 때 효과적)
      const items = await Promise.all(syms.map(sym => one(sym)));
      return json({ ok: true, items }, 200);
    }
    const symbol = url.searchParams.get("symbol") || "^KS11";
    if (url.searchParams.get("raw")) {
      const NVraw = { "KFUT": "FUT", "^KS11": "KOSPI", "^KQ11": "KOSDAQ", "^KS200": "KPI200" };
      if (NVraw[symbol]) return json(await naverFut(NVraw[symbol], symbol, true), 200);
    }
    const hist = url.searchParams.get("history");
    if (hist) return json(await history(symbol, url.searchParams.get("range") || "3mo"), 200);
    return json(await one(symbol), 200);
  },
};

async function history(symbol, range) {
  if (symbol === "FNG") return { ok: false, symbol, error: "no history" };
  const api = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(symbol) + "?interval=1d&range=" + encodeURIComponent(range);
  try {
    const res = await fetch(api, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return { ok: false, symbol, error: "yahoo " + res.status };
    const d = await res.json();
    const r = d?.chart?.result?.[0];
    const closes = r?.indicators?.quote?.[0]?.close;
    const ts = r?.timestamp;
    if (!closes || !ts) return { ok: false, symbol, error: "no data" };
    const pts = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) pts.push({ t: ts[i], c: round(closes[i], 2) });
    }
    // 카드(현재가)와 차트 끝점을 일치시킴: 마지막 점을 실시간 현재가로 보정
    const cur = r?.meta?.regularMarketPrice;
    if (cur != null && pts.length) pts[pts.length - 1].c = round(cur, 2);
    return { ok: true, symbol, name: r?.meta?.shortName || symbol, points: pts };
  } catch (e) {
    return { ok: false, symbol, error: String(e) };
  }
}

async function one(symbol) {
  // 특수 심볼: CNN Fear & Greed 지수
  if (symbol === "FNG") return await fearGreed();
  // 네이버에서 가져오는 한국 지수 (카드값을 네이버 실시간과 일치)
  const NV = { "KFUT": "FUT", "^KS11": "KOSPI", "^KQ11": "KOSDAQ", "^KS200": "KPI200" };
  if (NV[symbol]) return await naverFut(NV[symbol], symbol);
  // 네이버 개별 종목 시세: STK:종목코드 (아카이브 현재가용)
  if (symbol.startsWith("STK:")) return await naverStock(symbol.slice(4));
  // 미국채 2년물: 야후 수익률 선물(2YY=F) 우선, 실패 시 네이버 채권으로 폴백
  if (symbol === "UST2Y") {
    const y = await yahoo("2YY=F", "UST2Y");
    if (y.ok && y.price != null) return y;
    return await naverBond("US2YT=RR", "UST2Y");
  }
  // 달러인덱스: 야후(DX-Y.NYB) 우선, 실패 시 네이버 환율로 폴백
  if (symbol === "DX-Y.NYB") {
    const y = await yahoo("DX-Y.NYB", "DX-Y.NYB");
    if (y.ok && y.price != null) return y;
    return await naverFx(".DXY", "DX-Y.NYB");
  }

  return await yahoo(symbol, symbol);
}

// 야후 차트 API에서 현재가를 가져옴 (ticker=야후심볼, symbol=응답에 표기할 심볼)
async function yahoo(ticker, symbol) {
  const api = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(ticker) + "?interval=1d&range=1d";
  try {
    const res = await fetch(api, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: 5 },
    });
    if (!res.ok) return { ok: false, symbol, error: "yahoo " + res.status };
    const d = await res.json();
    const m = d?.chart?.result?.[0]?.meta;
    if (!m || m.regularMarketPrice == null) return { ok: false, symbol, error: "no price" };
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose ?? m.previousClose ?? price;
    const change = price - prev;
    const rate = prev ? (change / prev * 100) : 0;
    return {
      ok: true,
      symbol,
      name: m.shortName || m.symbol || symbol,
      price,
      change: round(change, 2),
      rate: round(rate, 2),
      currency: m.currency || "",
    };
  } catch (e) {
    return { ok: false, symbol, error: String(e) };
  }
}

async function fearGreed() {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return { ok: false, symbol: "FNG", error: "cnn " + res.status };
    const d = await res.json();
    const fg = d?.fear_and_greed;
    if (!fg || fg.score == null) return { ok: false, symbol: "FNG", error: "no score" };
    const score = Math.round(fg.score);
    const prev = fg.previous_close != null ? fg.previous_close : score;
    const change = score - prev;
    const rate = prev ? (change / prev * 100) : 0;
    return {
      ok: true,
      symbol: "FNG",
      name: "Fear & Greed (" + (fg.rating || "") + ")",
      price: score,
      change: round(change, 2),
      rate: round(rate, 2),
      currency: "",
    };
  } catch (e) {
    return { ok: false, symbol: "FNG", error: String(e) };
  }
}

async function naverFx(code, symbol) {
  const urls = [
    "https://m.stock.naver.com/api/marketindex/exchange/" + code + "/basic",
    "https://m.stock.naver.com/api/marketindex/exchange/" + code,
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": UA, "Accept": "application/json",
          "Referer": "https://m.stock.naver.com/marketindex/exchange/" + code,
        },
        cf: { cacheTtl: 30 },
      });
      if (!res.ok) continue;
      const d = await res.json();
      const priceRaw = d.closePrice ?? d.nowVal ?? d.currentPrice ?? d.price ?? d.value;
      const changeRaw = d.compareToPreviousClosePrice ?? d.changeVal ?? d.change;
      const price = num(priceRaw);
      const change = num(changeRaw);
      let rate = num(d.fluctuationsRatio ?? d.changeRate ?? d.rate);
      if (price == null) continue;
      const prev = price - (change ?? 0);
      if (rate == null) rate = prev ? ((change ?? 0) / prev * 100) : 0;
      return {
        ok: true, symbol, name: d.stockName || d.indexName || symbol,
        price: round(price, 2), change: round(change ?? 0, 2), rate: round(rate, 2),
        priceStr: priceRaw != null ? String(priceRaw) : null,
        changeStr: changeRaw != null ? String(changeRaw).replace(/^[-+]/, "") : null,
        currency: "",
      };
    } catch (e) { /* 다음 후보 */ }
  }
  return { ok: false, symbol, error: "fx fail" };
}

async function naverBond(code, symbol) {
  const urls = [
    "https://m.stock.naver.com/api/marketindex/bond/" + code + "/basic",
    "https://m.stock.naver.com/api/marketindex/bond/" + code,
    "https://api.stock.naver.com/marketindex/bond/" + code + "/basic",
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": UA, "Accept": "application/json",
          "Referer": "https://m.stock.naver.com/marketindex/bond/" + code,
        },
        cf: { cacheTtl: 30 },
      });
      if (!res.ok) continue;
      const d = await res.json();
      const priceRaw = d.closePrice ?? d.nowVal ?? d.currentPrice ?? d.price ?? d.value;
      const changeRaw = d.compareToPreviousClosePrice ?? d.changeVal ?? d.change;
      const price = num(priceRaw);
      const change = num(changeRaw);
      let rate = num(d.fluctuationsRatio ?? d.changeRate ?? d.rate);
      if (price == null) continue;
      const prev = price - (change ?? 0);
      if (rate == null) rate = prev ? ((change ?? 0) / prev * 100) : 0;
      return {
        ok: true, symbol, name: d.stockName || d.indexName || symbol,
        price: round(price, 2), change: round(change ?? 0, 2), rate: round(rate, 2),
        priceStr: priceRaw != null ? String(priceRaw) : null,
        changeStr: changeRaw != null ? String(changeRaw).replace(/^[-+]/, "") : null,
        currency: "",
      };
    } catch (e) { /* 다음 후보 */ }
  }
  return { ok: false, symbol, error: "bond fail" };
}

async function naverStock(code) {
  const u = "https://m.stock.naver.com/api/stock/" + code + "/basic";
  try {
    const res = await fetch(u, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://m.stock.naver.com/domestic/stock/" + code + "/total",
      },
      cf: { cacheTtl: 30 },
    });
    if (!res.ok) return { ok: false, symbol: "STK:" + code, error: "naver " + res.status };
    const d = await res.json();
    const priceRaw = d.closePrice ?? d.nowVal ?? d.currentPrice ?? d.tradePrice;
    const price = num(priceRaw);
    if (price == null) return { ok: false, symbol: "STK:" + code, error: "no price" };
    return {
      ok: true,
      symbol: "STK:" + code,
      name: d.stockName || code,
      price: round(price, 2),
      priceStr: priceRaw != null ? String(priceRaw) : null,
      currency: "KRW",
    };
  } catch (e) {
    return { ok: false, symbol: "STK:" + code, error: String(e) };
  }
}

async function naverFut(code, symbol, raw) {
  const urls = [
    "https://m.stock.naver.com/api/index/" + code + "/basic",
    "https://m.stock.naver.com/api/index/" + code + "/integration",
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Referer": "https://m.stock.naver.com/domestic/index/" + code + "/total",
        },
        cf: { cacheTtl: 10 },
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (raw) return { ok: true, source: u, data: d };  // 디버그: 원본 그대로
      const priceRaw = d.closePrice ?? d.nowVal ?? d.currentPrice ?? d.tradePrice ?? d.price;
      const changeRaw = d.compareToPreviousClosePrice ?? d.changeVal ?? d.change;
      const price = num(priceRaw);
      const change = num(changeRaw);
      let rate = num(d.fluctuationsRatio ?? d.changeRate ?? d.rate);
      if (price == null) continue;
      const prev = price - (change ?? 0);
      if (rate == null) rate = prev ? ((change ?? 0) / prev * 100) : 0;
      return {
        ok: true,
        symbol: symbol,
        name: d.stockName || d.indexName || symbol,
        price: round(price, 2),
        change: round(change ?? 0, 2),
        rate: round(rate, 2),
        priceStr: priceRaw != null ? String(priceRaw) : null,   // 원본 자릿수 유지
        changeStr: changeRaw != null ? String(changeRaw).replace(/^[-+]/, "") : null,
        currency: "",
      };
    } catch (e) { /* 다음 후보 시도 */ }
  }
  return { ok: false, symbol: symbol, error: "naver fail" };
}
// 티커로 네이버 검색 → 미국 월드스톡 페이지 주소를 만들어 돌려줌
// 응답: {ok:true, url:"https://m.stock.naver.com/worldstock/etf/QQQ.O/total", reutersCode, stockType}
// 디버그: ?nvlink=QQQ&raw=1 → 네이버 검색 원본 JSON 그대로
async function naverWorldUrl(ticker, raw) {
  ticker = String(ticker || "").trim().toUpperCase();
  if (!ticker) return { ok: false, error: "no ticker" };
  const q = encodeURIComponent(ticker);
  const urls = [
    "https://m.stock.naver.com/front-api/search/autoComplete?query=" + q + "&target=stock,etf,index",
    "https://api.stock.naver.com/front-api/search/autoComplete?query=" + q + "&target=stock,etf,index",
    "https://m.stock.naver.com/api/search/all?query=" + q,
    "https://api.stock.naver.com/search/all?query=" + q,
    "https://m.stock.naver.com/api/search/searchList?query=" + q,
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": UA, "Accept": "application/json",
          "Referer": "https://m.stock.naver.com/",
        },
        cf: { cacheTtl: 3600 },
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (raw) return { ok: true, source: u, data: d };  // 디버그: 원본 그대로

      // 검색 결과가 어디에 담겨 오든 모두 모음
      const bucket = [];
      const push = a => { if (Array.isArray(a)) bucket.push(...a); };
      const dig = o => { if (!o || typeof o !== "object") return;
        push(o.stocks); push(o.etfs); push(o.items); push(o.list);
        push(o.searchResultList); push(o.searchList); push(o.results); };
      dig(d); dig(d.result); dig(d.data);
      if (d.result) dig(d.result.result);

      const ric = x => String((x && (x.reutersCode || x.ric || x.code || x.symbolCode)) || "");
      const sym = x => String((x && (x.symbolCode || x.itemCode || x.code || x.symbol)) || "").toUpperCase();
      const isUSRic = c => /^[A-Za-z.\-]+\.[A-Za-z]+$/.test(c) && !/^\d{6}/.test(c); // 미국 RIC 형태(.O .N 등), 한국 6자리 제외

      const cands = bucket.filter(x => isUSRic(ric(x)));
      const pick =
        cands.find(x => sym(x) === ticker) ||
        cands.find(x => ric(x).split(".")[0].toUpperCase() === ticker) ||
        cands[0];
      if (!pick) continue;

      const code = ric(pick);                 // 예: QQQ.O
      let type = String((pick.stockType || pick.type || pick.typeCode || pick.stockEndType || "")).toLowerCase();
      type = type.includes("etf") ? "etf" : "stock";
      return {
        ok: true, ticker,
        url: "https://m.stock.naver.com/worldstock/" + type + "/" + code + "/total",
        reutersCode: code, stockType: type,
      };
    } catch (e) { /* 다음 후보 */ }
  }
  return { ok: false, ticker, error: "not found" };
}
function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

function round(n, p) {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}
// 공유 자료 저장/불러오기 (Cloudflare KV). GET=읽기, POST=쓰기
const ALLOWED_KEYS = new Set(["val_us", "val_usetf", "val_kretf", "val_kr"]);
async function handleData(request, env, key) {
  if (!ALLOWED_KEYS.has(key)) return json({ ok: false, error: "bad key" }, 400);
  if (!env || !env.KV) return json({ ok: false, error: "no kv binding" }, 500);
  try {
    if (request.method === "POST" || request.method === "PUT") {
      const body = await request.text();
      if (body.length > 2000000) return json({ ok: false, error: "too large" }, 413);
      await env.KV.put(key, body);
      return json({ ok: true }, 200);
    }
    const value = await env.KV.get(key);
    return json({ ok: true, value }, 200);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
