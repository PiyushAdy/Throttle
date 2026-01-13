-- ============================================================================
-- throttle.lua — ONE script, BOTH algorithms, the WHOLE rule stack
-- ============================================================================
--
-- This is the most-read file in the repo. Its shape is the whole design.
--
-- WHY ONE SCRIPT? (DECISIONS §11)
--   Redis executes a Lua script atomically — no other command interleaves
--   while it runs. Evaluating every rule attached to a request inside a
--   single invocation therefore makes *the stack itself* atomic, not merely
--   each rule. That buys two things a per-rule design cannot:
--
--     1. Evaluate-then-commit. Every rule is checked first; nothing is
--        written unless all rules allow. Any denial ⇒ zero writes anywhere
--        (all-or-nothing consumption, DECISIONS §9). A denied request never
--        spends a caller's headroom on a request that never ran.
--
--     2. One round trip. A request's entire limit decision is a single
--        EVALSHA, regardless of how many rules are stacked.
--
--   This is only possible because Cluster is out of scope (DECISIONS §16):
--   a Cluster script may only touch keys in one slot, and stacked rules
--   deliberately hash to unrelated slots.
--
-- TWO PASSES (keep them clearly separated — this is the review surface):
--
--   PASS 1 — EVALUATE. For each rule, dispatch on `algorithm` and compute
--   { allowed, remaining, limit, retryAfter, reset } *without writing
--   anything*. The only read-path work on the ZSET is ZCOUNT (no trim) and
--   ZRANGE for the oldest score. The token bucket's refill is computed but
--   NOT persisted on the denial path — the next request recomputes from the
--   stored lastRefillTs, which is correct and keeps denials write-free.
--
--   PASS 2 — COMMIT. Only if every rule allowed: consume on every rule and
--   refresh every TTL. If any rule denied, this pass is skipped entirely.
--
-- REPORT WORST (DECISIONS §10): while evaluating, the script tracks the
-- denied rule with the largest shortfall (how far over its limit the request
-- is). The worst rule is chosen HERE, inside the atomic section, so Node
-- never has to re-derive it.
--
-- ONE CLOCK (DECISIONS §5): `redis.call('TIME')` is called exactly once and
-- its timestamp is used for every rule. Per-rule clocks would let a long
-- stack straddle a millisecond boundary. Node's Date.now() is never trusted.
--
-- KEYS (DECISIONS §3, §6): one key per rule.
--   token bucket   → hash  { tokens: float, lastRefillTs: ms }
--   sliding window → zset  { member: <requestId>:<n>, score: ts in ms }
--   Every commit refreshes the key's TTL (bucket: time to refill from empty;
--   window: the window length). Expiry is a safety net that reclaims memory
--   for keys nobody uses — it is NOT the limiter mechanism.
--
-- INTERFACE
--   KEYS[1..N]   one key per rule, same order as the descriptor array
--   ARGV[1]      JSON array of rule descriptors:
--                [{ algorithm, params, cost, ruleName, requestId }, ...]
--   returns      JSON string:
--                { allowed: 0|1, worstRule: "name"|"",
--                  results: [{ ruleName, allowed, remaining, limit,
--                              retryAfter, reset }, ...] }
--
-- BOUNDED WORK: the script is O(rules). ZREMRANGEBYSCORE/ZCOUNT do the
-- window trimming; there is no loop over window members. Redis is
-- single-threaded while a script runs — keep it short.
-- ============================================================================

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local rules = cjson.decode(ARGV[1])
local n = #rules

local evaluated = {}
local results = {}
local allAllowed = true

-- Worst-rule tracking (DECISIONS §10): largest shortfall wins.
-- Tie-breaks: lower remaining, then lower limit, then first evaluated.
local worstIdx = 0
local worstShortfall = -1
local worstRemaining = math.huge
local worstLimit = math.huge

for i = 1, n do
  local rule = rules[i]
  local key = KEYS[i]
  local cost = tonumber(rule.cost)
  if cost == nil or cost < 1 then
    cost = 1 -- defensive; Node clamps and validates before we ever see it
  end

  local e = {}
  e.allowed = false
  e.remaining = 0
  e.retryAfter = 0
  e.reset = 0
  e.shortfall = -1

  if rule.algorithm == 'token-bucket' then
    -- ------------------------------------------------------------------
    -- Token bucket (DECISIONS §3): hash { tokens, lastRefillTs },
    -- refilled lazily right here — there is no background ticker.
    -- ------------------------------------------------------------------
    local capacity = tonumber(rule.params.capacity)
    local refillPerSec = tonumber(rule.params.refillPerSecond)
    local rate = refillPerSec / 1000.0 -- tokens per millisecond

    local rawTokens = redis.call('HGET', key, 'tokens')
    local tokens
    if rawTokens == false then
      -- Absent key ⇒ bucket starts full; lastRefillTs = now ⇒ zero refill due.
      tokens = capacity
      e.lastRefill = now
    else
      tokens = tonumber(rawTokens)
      e.lastRefill = tonumber(redis.call('HGET', key, 'lastRefillTs')) or now
    end

    local elapsed = now - e.lastRefill
    if elapsed < 0 then elapsed = 0 end -- never refill backwards

    local filled = tokens + elapsed * rate
    if filled > capacity then filled = capacity end

    e.allowed = filled >= cost
    if e.allowed then
      e.remaining = math.floor(filled - cost)
      e.shortfall = -1
    else
      e.remaining = math.floor(filled)
      e.shortfall = cost - filled
      if rate > 0 then
        e.retryAfter = math.ceil((cost - filled) / rate / 1000)
        if e.retryAfter < 1 then e.retryAfter = 1 end
      else
        e.retryAfter = 2147483647 -- a bucket that never refills
      end
    end
    if rate > 0 then
      e.reset = math.ceil((capacity - filled) / rate / 1000)
      if e.reset < 0 then e.reset = 0 end
    end

    e.limit = capacity
    e.commitTokens = filled
    e.refillPerSec = refillPerSec
  else
    -- ------------------------------------------------------------------
    -- Sliding window (DECISIONS §3): ZSET per key, member = unique request
    -- id, score = timestamp in ms. Exact — no edge-of-window burst artifact.
    -- Evaluate via ZCOUNT with an exclusive lower bound instead of trimming:
    -- same count ZREMRANGEBYSCORE would leave behind, zero writes on the
    -- denial path.
    -- ------------------------------------------------------------------
    local limit = tonumber(rule.params.limit)
    local windowMs = tonumber(rule.params.windowMs)

    local count = tonumber(redis.call('ZCOUNT', key, '(' .. tostring(now - windowMs), '+inf'))
    e.windowCount = count
    e.windowMs = windowMs

    e.allowed = (count + cost) <= limit
    e.remaining = limit - count
    if e.allowed then e.remaining = e.remaining - cost end

    if e.allowed then
      e.shortfall = -1
    else
      e.shortfall = (count + cost) - limit
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      if count > 0 and #oldest >= 2 then
        -- Time until the oldest member slides out and frees a slot.
        e.retryAfter = math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000)
        if e.retryAfter < 1 then e.retryAfter = 1 end
        if e.remaining <= 0 then
          e.reset = e.retryAfter
        end
      else
        -- The window is empty yet still denies: cost alone exceeds the
        -- limit. Nothing will free a slot — wait for a fresh window.
        e.retryAfter = math.ceil(windowMs / 1000)
        if e.retryAfter < 1 then e.retryAfter = 1 end
        e.reset = e.retryAfter
      end
    end

    e.limit = limit
  end

  evaluated[i] = e

  results[i] = {
    ruleName = rule.ruleName,
    allowed = e.allowed and 1 or 0,
    remaining = e.remaining,
    limit = e.limit,
    retryAfter = e.retryAfter,
    reset = e.reset,
  }

  if not e.allowed then
    allAllowed = false
    if
      e.shortfall > worstShortfall
      or (e.shortfall == worstShortfall and e.remaining < worstRemaining)
      or (e.shortfall == worstShortfall and e.remaining == worstRemaining and e.limit < worstLimit)
    then
      worstIdx = i
      worstShortfall = e.shortfall
      worstRemaining = e.remaining
      worstLimit = e.limit
    end
  end
end

-- ==========================================================================
-- PASS 2 — COMMIT. Runs only when every rule allowed. Any denial above
-- means this loop never executes and *nothing* was written (§9).
-- ==========================================================================
if allAllowed then
  for i = 1, n do
    local rule = rules[i]
    local key = KEYS[i]
    local e = evaluated[i]
    local cost = tonumber(rule.cost)
    if cost == nil or cost < 1 then cost = 1 end

    if rule.algorithm == 'token-bucket' then
      -- Persist the refill computed in pass 1 and consume the cost.
      redis.call('HSET', key, 'tokens', e.commitTokens - cost, 'lastRefillTs', now)
      -- TTL = time to fully refill from empty (DECISIONS §6), refreshed per write.
      local ttl = math.ceil(e.limit / e.refillPerSec)
      if ttl < 1 then ttl = 1 end
      redis.call('EXPIRE', key, ttl)
    else
      -- Now the trim, then charge `cost` members (documented decision for D1:
      -- one ZSET member per unit of cost, so the log stays exact).
      redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. tostring(now - e.windowMs))
      local memberBase = rule.requestId
      for j = 0, cost - 1 do
        redis.call('ZADD', key, now, memberBase .. ':' .. j)
      end
      -- TTL = the window length (DECISIONS §6), refreshed per write.
      redis.call('PEXPIRE', key, e.windowMs)
    end
  end
end

local out = {
  allowed = allAllowed and 1 or 0,
  worstRule = '',
  results = results,
}
if worstIdx > 0 then
  out.worstRule = rules[worstIdx].ruleName
end

return cjson.encode(out)
