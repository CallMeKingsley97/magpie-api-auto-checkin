// new-api 额度读取。
//
// 两把钥匙能打开的接口：公开的 /api/status（站点按什么货币显示）和用 sk-…
// 令牌读的 /api/usage/token/（这把令牌还剩多少）。/api/user/self 要登录态，
// 令牌一律 401，所以这里不能依赖它。

import test from "node:test"
import assert from "node:assert/strict"

import { readNewApi, currencyOf, amountOf } from "../lib/newapi.mjs"
import { fakeFetch, countCalls } from "./helpers.mjs"

const SITE = "https://newapi.example.com"

const status = (data = {}) => ({
  match: (url) => url.endsWith("/api/status"),
  body: { success: true, data: { quota_per_unit: 500000, quota_display_type: "USD", usd_exchange_rate: 7, ...data } },
})

const tokenUsage = (data) => ({
  match: (url) => url.endsWith("/api/usage/token/"),
  body: { code: true, message: "ok", data: { name: "default", ...data } },
})

test("new-api：按令牌额度给出余额和额度窗口", async () => {
  const f = fakeFetch([
    status(),
    tokenUsage({ total_granted: 5_000_000, total_used: 1_000_000, total_available: 4_000_000, unlimited_quota: false, expires_at: 0 }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.balance, "$8")
  assert.equal(card.account, "default")
  assert.equal(card.until, undefined)
  assert.equal(card.windows.length, 1)
  const w = card.windows[0]
  assert.equal(w.name, "额度")
  assert.equal(w.used, 20)
  assert.equal(w.amount, 2)
  assert.equal(w.limit, 10)
  assert.equal(w.unit, "USD")
  assert.equal(w.display, "$2 / $10")
  // 令牌通过 Authorization 头带上，不放 query
  assert.match(f.calls.find((c) => c.path === "/api/usage/token/").headers.Authorization, /^Bearer sk-x$/)
})

test("new-api：无限额度且站点允许查用户额度时，看用户账上的余额", async () => {
  const f = fakeFetch([
    status(),
    tokenUsage({
      total_granted: -1,
      total_used: 0,
      total_available: 0,
      unlimited_quota: true,
      user_quota: { total_available: 2_500_000, total_used: 2_500_000 },
    }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.balance, "$5")
  assert.equal(card.windows.length, 1)
  assert.equal(card.windows[0].used, 50)
  assert.equal(card.windows[0].limit, 10)
})

test("new-api：无限额度又查不到用户额度时，不编数字，写「无限」", async () => {
  const f = fakeFetch([status(), tokenUsage({ unlimited_quota: true, total_granted: -1, total_used: 0, total_available: 0 })])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.balance, "无限")
  assert.equal(card.windows, undefined)
})

test("new-api：读数接口不通时才报错，余额不会假报成 0", async () => {
  const f = fakeFetch([status(), { match: (url) => url.endsWith("/api/usage/token/"), status: 500, body: { message: "boom" } }])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.match(card.error, /读额度失败/)
  assert.equal(card.balance, undefined)
})

test("new-api：令牌被拒时标成要重新登录，并说清该用哪种令牌", async () => {
  const f = fakeFetch([
    status(),
    { match: (url) => url.endsWith("/api/usage/token/"), status: 401, body: { code: false, message: "unauthorized" } },
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.signIn, "expired")
  assert.match(card.error, /sk-/)
})

test("new-api：站点按人民币显示时换算成 ¥，不把 quota 当美元", async () => {
  const f = fakeFetch([
    status({ quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 7 }),
    tokenUsage({ total_granted: 5_000_000, total_used: 0, total_available: 5_000_000, unlimited_quota: false }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  // 10 USD × 7 = ¥70
  assert.equal(card.balance, "¥70")
  assert.equal(card.windows[0].unit, "CNY")
  assert.equal(card.windows[0].limit, 70)
})

test("new-api：/api/status 不通也照样读出令牌额度（按美元显示）", async () => {
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/status"), status: 500, body: {} },
    tokenUsage({ total_granted: 1_000_000, total_used: 0, total_available: 1_000_000, unlimited_quota: false }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.balance, "$2")
})

test("new-api：额度太小也不显示成 0", async () => {
  const f = fakeFetch([
    status(),
    tokenUsage({ total_granted: 1_500, total_used: 1_450, total_available: 50, unlimited_quota: false }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.balance, "$0.0001")
})

test("new-api：到期时间按秒转成毫秒；-1（永不过期）不显示", async () => {
  const f = fakeFetch([
    status(),
    tokenUsage({ total_granted: 1, total_used: 0, total_available: 1, unlimited_quota: false, expires_at: 1_800_000_000 }),
  ])
  const card = await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(card.until, 1_800_000_000_000)

  const g = fakeFetch([
    status(),
    tokenUsage({ total_granted: 1, total_used: 0, total_available: 1, unlimited_quota: false, expires_at: -1 }),
  ])
  assert.equal((await readNewApi(SITE, "sk-x", { fetchImpl: g })).until, undefined)
})

test("new-api：没有令牌时不发请求，直接说清原因", async () => {
  const f = fakeFetch([])
  const card = await readNewApi(SITE, "", { fetchImpl: f })
  assert.match(card.error, /没有令牌/)
  assert.equal(f.calls.length, 0)
})

test("currencyOf：没配货币时的占位符 ¤ 不画到卡片上", () => {
  const cur = currencyOf({ quota_display_type: "CUSTOM", custom_currency_symbol: "¤", custom_currency_exchange_rate: 2 })
  assert.equal(cur.symbol, "")
  // 1 USD × 自定义汇率 2 = 2，没有符号可画就只给数字
  assert.equal(amountOf(500000, cur).text, "2")

  const eur = currencyOf({ quota_display_type: "CUSTOM", custom_currency_symbol: "€", custom_currency_exchange_rate: 0.9 })
  assert.equal(amountOf(500000, eur).text, "€ 0.9")
})

test("currencyOf：display_in_currency=false 当令牌数显示", () => {
  const cur = currencyOf({ display_in_currency: false })
  assert.equal(cur.type, "TOKENS")
  assert.equal(amountOf(5_000_000, cur).text, "5000000")
})

test("订阅接口与令牌接口只读一次就够（不会重复打同一个接口）", async () => {
  const f = fakeFetch([
    status(),
    tokenUsage({ total_granted: 1, total_used: 0, total_available: 1, unlimited_quota: false }),
  ])
  await readNewApi(SITE, "sk-x", { fetchImpl: f })
  assert.equal(countCalls(f, "/api/usage/token/"), 1)
  assert.equal(countCalls(f, "/api/status"), 1)
})
