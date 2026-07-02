import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0", ""].includes(normalized)) return false;
  }
  return Boolean(value);
}

function pickRankArray(payload) {
  const candidates = [
    payload?.data?.rank,
    payload?.data?.data?.rank,
    payload?.rank,
    payload?.data,
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeTrendingToken(item, interval) {
  const mint = item?.address || item?.token_address || item?.mint || null;
  return {
    mint,
    address: mint,
    symbol: item?.symbol || null,
    name: item?.name || null,
    chain: item?.chain || "sol",
    interval,
    rank: num(item?.rank),
    hot_level: num(item?.hot_level),
    market_cap: num(item?.market_cap ?? item?.usd_market_cap),
    liquidity: num(item?.liquidity),
    volume: num(item?.volume),
    swaps: num(item?.swaps),
    buys: num(item?.buys),
    sells: num(item?.sells),
    holder_count: num(item?.holder_count),
    price: num(item?.price),
    price_change_percent: num(item?.price_change_percent),
    price_change_percent5m: num(item?.price_change_percent5m),
    top_10_holder_rate: num(item?.top_10_holder_rate),
    rug_ratio: num(item?.rug_ratio),
    bundler_rate: num(item?.bundler_rate),
    insider_rate: num(item?.insider_rate ?? item?.rat_trader_amount_rate),
    is_wash_trading: bool(item?.is_wash_trading),
    smart_degen_count: num(item?.smart_degen_count),
    renowned_count: num(item?.renowned_count),
    launchpad_platform: item?.launchpad_platform || null,
    exchange: item?.exchange || null,
    open_timestamp: num(item?.open_timestamp),
    creation_timestamp: num(item?.creation_timestamp),
    raw: item,
  };
}

export async function getGmgnTrendingTokens(options = {}) {
  if (!hasGmgnApiKey()) {
    throw new Error("GMGN_API_KEY is required for gmgn_trending screening.");
  }

  const interval = options.interval || config.gmgn?.trendingInterval || "5m";
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? config.gmgn?.trendingLimit ?? 100)));
  const params = {
    chain: options.chain || "sol",
    interval,
    order_by: options.orderBy || config.gmgn?.trendingOrderBy || "volume",
    direction: options.direction || "desc",
    limit,
    min_marketcap: options.minMarketcap ?? config.gmgn?.minMarketcap,
    max_marketcap: options.maxMarketcap ?? config.gmgn?.maxMarketcap,
    min_volume: options.minVolume ?? config.gmgn?.minVolume,
    min_swaps: options.minSwaps ?? config.gmgn?.minSwaps,
    min_liquidity: options.minLiquidity ?? config.gmgn?.minLiquidity,
  };

  const payload = await gmgnFetch("/v1/market/rank", { params });
  const tokens = pickRankArray(payload)
    .map((item) => normalizeTrendingToken(item, interval))
    .filter((token) => token.mint);

  return {
    source: "gmgn_trending",
    interval,
    total: tokens.length,
    tokens,
  };
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}
