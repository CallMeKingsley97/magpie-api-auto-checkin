// sub2api 额度读取。
//
// sub2api 给两把不同的钥匙：
//  - API 密钥（sk-…，providers.json 里那把）→ GET /v1/usage，答“这把 key 还剩多少”；
//  - 登录令牌（邮箱密码登录拿到的 JWT）→ GET /api/v1/user/profile，答账号余额。
// 两种回答都整理成 magpie 的额度结构。

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { resetRateLimits } from "../lib/core.mjs"
import { cardOfUsage, readSub2Api } from "../lib/sub2api.mjs"
import { fakeFetch, countCalls, lastBody } from "./helpers.mjs"

const SITE = "https://s2a.example.com"

beforeEach(() => resetRateLimits())

test("sub2api：钱包余额模式只给余额，不给假窗口", async () => {
  const f = fakeFetch([
    {
      match: (url) => url.endsWith("/v1/usage"),
      body: { mode: "unrestricted", isValid: true, planName: "钱包余额", remaining: 6.71, unit: "USD", balance: 6.71 },
    },
  ])
  const card = await readSub2Api(SITE, { key: "sk-abc" }, { fetchImpl: f })
  assert.equal(card.balance, "$6.71")
  assert.equal(card.windows, undefined)
  // sub2api 自己的占位名“钱包余额”不当套餐名：有它会挡住 magpie 的余额卡排版
  assert.equal(card.plan, undefined)
  assert.match(f.calls[0].headers.Authorization, /^Bearer sk-abc$/)
})

test("sub2api：quota_limited 模式给总额度和速率窗口", () => {
  const card = cardOfUsage({
    mode: "quota_limited",
    isValid: true,
    quota: { limit: 10, used: 2.5, remaining: 7.5, unit: "USD" },
    remaining: 7.5,
    unit: "USD",
    rate_limits: [
      { window: "5h", limit: 2, used: 0.5, remaining: 1.5, window_start: "2026-10-24T00:00:00Z", reset_at: "2026-10-24T05:00:00Z" },
      { window: "7d", limit: 20, used: 5, remaining: 15, reset_at: "2026-10-31T00:00:00Z" },
    ],
    expires_at: "2026-12-01T00:00:00Z",
  })
  assert.equal(card.balance, "$7.5")
  assert.equal(card.windows.length, 3)
  const [total, five, week] = card.windows
  assert.equal(total.name, "额度")
  assert.equal(total.used, 25)
  assert.equal(total.display, "$2.5 / $10")
  assert.equal(five.name, "5 小时")
  assert.equal(five.used, 25)
  assert.equal(five.resetsAt, "2026-10-24T05:00:00.000Z")
  assert.equal(week.name, "7 天")
  assert.equal(week.used, 25)
  assert.equal(card.until, "2026-12-01T00:00:00.000Z")
})

test("sub2api：订阅模式按日/周/月限度画窗口，套餐名照实给", () => {
  const card = cardOfUsage({
    mode: "unrestricted",
    isValid: true,
    planName: "Pro",
    remaining: 3,
    unit: "USD",
    subscription: {
      daily_usage_usd: 1,
      daily_limit_usd: 2,
      weekly_usage_usd: 4,
      weekly_limit_usd: 20,
      monthly_usage_usd: 30,
      monthly_limit_usd: 100,
      expires_at: "2026-11-20T00:00:00Z",
    },
  })
  assert.equal(card.plan, "Pro")
  assert.equal(card.windows.length, 3)
  assert.deepEqual(card.windows.map((w) => w.name), ["每天", "每周", "每月"])
  assert.equal(card.windows[0].used, 50)
  assert.equal(card.until, "2026-11-20T00:00:00.000Z")
})

test("sub2api：限为 0 或读数缺失的窗口跳过，不画 0/0", () => {
  const card = cardOfUsage({
    quota: { limit: 0, used: 0, remaining: 0 },
    rate_limits: [{ window: "5h", limit: 0, used: 0 }, { window: "1d", limit: 5 }],
  })
  assert.equal(card.windows, undefined)
  assert.equal(card.balance, undefined)
})

test("sub2api：API 密钥被拒时说清用哪种密钥", async () => {
  const f = fakeFetch([{ match: (url) => url.endsWith("/v1/usage"), status: 401, body: { error: "Invalid API key" } }])
  const card = await readSub2Api(SITE, { key: "sk-bad" }, { fetchImpl: f })
  assert.match(card.error, /sk-/)
  assert.equal(card.balance, undefined)
})

test("sub2api：登录令牌走 /api/v1/user/profile，读出余额", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig"
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/v1/user/profile"), body: { code: 0, data: { email: "a@b.c", balance: 13.43 } } },
  ])
  const card = await readSub2Api(SITE, { access: jwt, expires: 2_000_000_000_000 }, { fetchImpl: f })
  assert.equal(card.balance, "$13.43")
  assert.equal(countCalls(f, "/v1/usage"), 0, "登录令牌不是网关密钥，不该去敲 /v1/usage")
})

test("sub2api：登录令牌过期时用 refresh_token 续期，并把新令牌交回去保存", async () => {
  const oldJwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9.sig"
  let saved
  const f = fakeFetch([
    {
      match: (url) => url.endsWith("/api/v1/auth/refresh"),
      body: { code: 0, data: { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.new", refresh_token: "r2" } },
    },
    { match: (url) => url.endsWith("/api/v1/user/profile"), body: { code: 0, data: { balance: 1.5 } } },
  ])
  const card = await readSub2Api(
    SITE,
    { access: oldJwt, refresh: "r1", expires: 1_600_000_000_000, site: SITE },
    { fetchImpl: f, save: (c) => (saved = c) },
  )
  assert.equal(card.balance, "$1.5")
  assert.equal(card.signIn, "renewed")
  assert.equal(lastBody(f, "/api/v1/auth/refresh").refresh_token, "r1")
  assert.equal(saved.access, "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.new")
  assert.equal(saved.refresh, "r2")
})

test("sub2api：续期也失败时标成要重新登录，不再继续读", async () => {
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/v1/auth/refresh"), status: 401, body: { code: 401, message: "invalid refresh token" } },
  ])
  const card = await readSub2Api(
    SITE,
    { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9.x", refresh: "r1", expires: 1_600_000_000_000, site: SITE },
    { fetchImpl: f },
  )
  assert.equal(card.signIn, "expired")
  assert.match(card.error, /登录态失效/)
  assert.equal(countCalls(f, "/api/v1/user/profile"), 0)
})

test("sub2api：续期本身遇到限流时报限流，不把账号误标成登录失效", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9.sig"
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/v1/auth/refresh"), status: 429, headers: { "Retry-After": "60" }, body: {} },
    { match: (url) => url.endsWith("/api/v1/user/profile"), body: { code: 0, data: { balance: 2 } } },
  ])
  const card = await readSub2Api(SITE, { access: jwt, refresh: "r1", expires: 1_600_000_000_000, site: SITE }, { fetchImpl: f })
  // 429 记进退避，后面的请求被挡下：卡片说限流（而不是“登录失效”）
  assert.match(card.error, /限流/)
  assert.equal(card.signIn, undefined)
})
