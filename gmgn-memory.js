import fs from "fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const GMGN_MEMORY_FILE = repoPath("gmgn-memory.json");

function enabled() {
  return config.gmgnMemory?.enabled !== false;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMint(mint) {
  const value = String(mint || "").trim();
  return value || null;
}

function sanitize(text, maxLen = 160) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function load() {
  if (!fs.existsSync(GMGN_MEMORY_FILE)) return { tokens: {}, updated_at: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(GMGN_MEMORY_FILE, "utf8"));
    if (parsed?.tokens && typeof parsed.tokens === "object") return parsed;
    return { tokens: {}, updated_at: null };
  } catch {
    return { tokens: {}, updated_at: null };
  }
}

function save(db) {
  db.updated_at = nowIso();
  try {
    fs.writeFileSync(GMGN_MEMORY_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    log("gmgn-memory", `save failed: ${error.message}`);
  }
}

function eventLimit() {
  return Math.max(5, Number(config.gmgnMemory?.maxEventsPerToken ?? 30));
}

function trimEvents(entry) {
  const limit = eventLimit();
  for (const key of ["rejects", "deploys", "closes"]) {
    if (Array.isArray(entry[key]) && entry[key].length > limit) {
      entry[key] = entry[key].slice(-limit);
    }
  }
}

function ensureEntry(db, tokenOrMint) {
  const mint = normalizeMint(tokenOrMint?.mint || tokenOrMint?.base_mint || tokenOrMint);
  if (!mint) return null;
  if (!db.tokens[mint]) {
    db.tokens[mint] = {
      mint,
      symbol: null,
      first_seen_at: nowIso(),
      last_seen_at: null,
      seen_count: 0,
      last_rank: null,
      last_metrics: {},
      resolved_pools: {},
      rejects: [],
      deploys: [],
      closes: [],
      cooldown_until: null,
      cooldown_reason: null,
      last_outcome: null,
    };
  }
  const entry = db.tokens[mint];
  if (!entry.resolved_pools || typeof entry.resolved_pools !== "object" || Array.isArray(entry.resolved_pools)) entry.resolved_pools = {};
  if (!Array.isArray(entry.rejects)) entry.rejects = [];
  if (!Array.isArray(entry.deploys)) entry.deploys = [];
  if (!Array.isArray(entry.closes)) entry.closes = [];
  if (tokenOrMint?.symbol) entry.symbol = sanitize(tokenOrMint.symbol, 32);
  return entry;
}

function setCooldown(entry, ms, reason) {
  if (!entry || !Number.isFinite(ms) || ms <= 0) return;
  const until = new Date(Date.now() + ms).toISOString();
  if (!entry.cooldown_until || new Date(entry.cooldown_until) < new Date(until)) {
    entry.cooldown_until = until;
    entry.cooldown_reason = sanitize(reason, 120);
  }
}

function applyRejectCooldown(entry, reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("no SOL-quote DLMM".toLowerCase()) || text.includes("no_dlmm_sol_pool")) {
    const minutes = Number(config.gmgnMemory?.noPoolCooldownMinutes ?? 20);
    setCooldown(entry, minutes * 60_000, "no_dlmm_sol_pool");
  }
}

function classifyClose(perf) {
  const text = String(perf?.close_reason || "").toLowerCase();
  if (text.includes("single down profit lock") || text.includes("single_down_tp")) return "single_down_profit_lock";
  if (text.includes("low yield")) return "low_yield";
  if (text.includes("stop loss")) return "stop_loss";
  if (text === "oor" || text.includes("out of range") || text.includes("oor")) {
    return perf?.bin_range?.shape === "single_down" ? "oor_below" : "oor";
  }
  const pnl = safeNumber(perf?.pnl_pct);
  if (pnl != null && pnl > 0) return "profit";
  if (pnl != null && pnl < 0) return "loss";
  return "closed";
}

function applyCloseCooldown(entry, closeClass) {
  if (closeClass === "low_yield") {
    setCooldown(entry, Number(config.gmgnMemory?.lowYieldCooldownHours ?? 4) * 3_600_000, "low_yield");
  } else if (closeClass === "oor_below") {
    setCooldown(entry, Number(config.gmgnMemory?.oorBelowCooldownHours ?? 12) * 3_600_000, "oor_below");
  } else if (closeClass === "stop_loss") {
    setCooldown(entry, Number(config.gmgnMemory?.stopLossCooldownHours ?? 12) * 3_600_000, "stop_loss");
  }
}

function prune(db) {
  const retentionDays = Number(config.gmgnMemory?.retentionDays ?? 7);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return db;
  const cutoff = Date.now() - retentionDays * 24 * 3_600_000;
  const now = Date.now();
  for (const [mint, entry] of Object.entries(db.tokens || {})) {
    const lastSeen = entry.last_seen_at ? new Date(entry.last_seen_at).getTime() : 0;
    const cooldownActive = entry.cooldown_until && new Date(entry.cooldown_until).getTime() > now;
    if (!cooldownActive && lastSeen > 0 && lastSeen < cutoff) delete db.tokens[mint];
  }
  return db;
}

export function getGmgnMemorySnapshot() {
  return load();
}

export function getGmgnCooldown(mint, db = null) {
  if (!enabled()) return { active: false };
  const key = normalizeMint(mint);
  if (!key) return { active: false };
  const entry = (db || load()).tokens?.[key];
  if (!entry?.cooldown_until) return { active: false };
  const untilMs = new Date(entry.cooldown_until).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return { active: false };
  return {
    active: true,
    until: entry.cooldown_until,
    reason: entry.cooldown_reason || "gmgn_memory_cooldown",
  };
}

export function getGmgnMemoryScoreAdjustment(mint, db = null) {
  if (!enabled()) return { adjustment: 0, reason: null };
  const key = normalizeMint(mint);
  if (!key) return { adjustment: 0, reason: null };
  const entry = (db || load()).tokens?.[key];
  if (!entry) return { adjustment: 0, reason: null };

  const cooldown = getGmgnCooldown(key, db || { tokens: { [key]: entry } });
  if (cooldown.active) return { adjustment: -100000, reason: `cooldown: ${cooldown.reason}` };

  const boost = Number(config.gmgnMemory?.repeatWinnerBoost ?? 10);
  const penalty = Number(config.gmgnMemory?.repeatLoserPenalty ?? 15);
  const closes = Array.isArray(entry.closes) ? entry.closes : [];
  const recent = closes.slice(-3);
  let adjustment = 0;
  const reasons = [];

  const last = closes[closes.length - 1];
  if (last?.class === "single_down_profit_lock") {
    adjustment += boost;
    reasons.push("last single_down profit lock");
  }

  const wins = recent.filter((close) => close.class === "single_down_profit_lock" || safeNumber(close.pnl_pct) > 0).length;
  const losses = recent.filter((close) => ["low_yield", "oor_below", "stop_loss"].includes(close.class) || safeNumber(close.pnl_pct) < 0).length;
  if (wins >= 2) {
    adjustment += Math.min(2, wins - 1) * boost;
    reasons.push(`${wins} recent winners`);
  }
  if (losses > 0) {
    adjustment -= losses * penalty;
    reasons.push(`${losses} recent losers`);
  }

  return { adjustment, reason: reasons.join("; ") || null };
}

export function recordGmgnDiscovery({ seenTokens = [], rejects = [], resolved = [] } = {}) {
  if (!enabled()) return;
  const db = load();
  const ts = nowIso();

  for (const token of seenTokens) {
    const entry = ensureEntry(db, token);
    if (!entry) continue;
    entry.last_seen_at = ts;
    entry.seen_count = Number(entry.seen_count || 0) + 1;
    entry.last_rank = safeNumber(token.rank);
    entry.last_metrics = {
      market_cap: safeNumber(token.market_cap),
      volume_5m: safeNumber(token.volume),
      swaps_5m: safeNumber(token.swaps),
      liquidity: safeNumber(token.liquidity),
      rug_ratio: safeNumber(token.rug_ratio),
      top_10_holder_rate: safeNumber(token.top_10_holder_rate),
      smart_degen_count: safeNumber(token.smart_degen_count),
    };
  }

  for (const item of resolved) {
    const entry = ensureEntry(db, item.token);
    const pool = item.pool;
    const poolAddress = sanitize(pool?.pool || pool?.pool_address, 64);
    if (!entry || !poolAddress) continue;
    if (!entry.resolved_pools[poolAddress]) {
      entry.resolved_pools[poolAddress] = {
        first_resolved_at: ts,
        last_resolved_at: null,
        count: 0,
        name: null,
        tvl: null,
      };
    }
    const resolvedPool = entry.resolved_pools[poolAddress];
    resolvedPool.last_resolved_at = ts;
    resolvedPool.count = Number(resolvedPool.count || 0) + 1;
    resolvedPool.name = sanitize(pool?.name, 80);
    resolvedPool.tvl = safeNumber(pool?.tvl ?? pool?.active_tvl);
  }

  for (const item of rejects) {
    const entry = ensureEntry(db, item.token || item.mint);
    if (!entry) continue;
    const reason = sanitize(item.reason, 160) || "rejected";
    entry.rejects.push({ ts, reason });
    applyRejectCooldown(entry, reason);
  }

  for (const entry of Object.values(db.tokens)) trimEvents(entry);
  save(prune(db));
  if (seenTokens.length || rejects.length || resolved.length) {
    log("gmgn-memory", `discovery saved seen=${seenTokens.length} resolved=${resolved.length} rejected=${rejects.length}`);
  }
}

export function recordGmgnDeploy({ base_mint, pool, pool_name, position, amount_sol, strategy } = {}) {
  if (!enabled()) return;
  const mint = normalizeMint(base_mint);
  if (!mint) return;
  const db = load();
  if (!db.tokens[mint] && config.screening?.candidateSource !== "gmgn_trending") return;
  const entry = ensureEntry(db, { mint });
  entry.deploys.push({
    ts: nowIso(),
    pool: sanitize(pool, 64),
    pool_name: sanitize(pool_name, 80),
    position: sanitize(position, 64),
    amount_sol: safeNumber(amount_sol),
    strategy: sanitize(strategy, 32),
  });
  trimEvents(entry);
  save(prune(db));
}

export function recordGmgnClose(perf = {}) {
  if (!enabled()) return;
  const mint = normalizeMint(perf.base_mint || perf.signal_snapshot?.base_mint);
  if (!mint) return;
  const db = load();
  if (!db.tokens[mint] && perf.signal_snapshot?.source !== "gmgn_trending" && config.screening?.candidateSource !== "gmgn_trending") return;
  const entry = ensureEntry(db, { mint });
  const closeClass = classifyClose(perf);
  entry.closes.push({
    ts: perf.recorded_at || nowIso(),
    class: closeClass,
    pool: sanitize(perf.pool, 64),
    pool_name: sanitize(perf.pool_name, 80),
    position: sanitize(perf.position, 64),
    pnl_pct: safeNumber(perf.pnl_pct),
    fees_earned_usd: safeNumber(perf.fees_earned_usd),
    minutes_held: safeNumber(perf.minutes_held),
    close_reason: sanitize(perf.close_reason, 180),
  });
  entry.last_outcome = closeClass;
  applyCloseCooldown(entry, closeClass);
  trimEvents(entry);
  save(prune(db));
}
