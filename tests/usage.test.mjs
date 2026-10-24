// Usage 卡片：magpie 界面上每个账号看到的那张小卡。
//
// 卡片交出去的是 magpie 自己的额度结构：user / plan / windows / balance /
// until / error / signIn。magpie 负责排版、翻译、以及按窗口百分比和余额做额度
// 提醒，所以这里要保证字段本身是对的——尤其 balance 必须是它能解析的金额。

import test from "node:test"
import assert from "node:assert/strict"

import { usageFor, resetUsageCache } from "../lib/usage.mjs"
import { resetRateLimits } from "../lib/core.mjs"
import { resetDetectCache } from "../lib/detect.mjs"
import { fakeFetch } from "./helpers.mjs"

const SITE = "https://newapi.example.com"
const DIR = "/tmp/quota-manager-usage-test"

const statusBody = { success: true, data: { quota_per_unit: 500000, quota_display_type: "USD" } }

/** new-api：公开状态 + 令牌额度。 */
const newApiFetch = (data = {}) =>
  fakeFetch([
    { match: (url) => url.endsWith("/api/status"), body: statusBody },
    {
      match: (url) => url.endsWith("/api/usage/token/"),
      body: {
        code: true,
        data: { name: "default", total_granted: 5_000_000, total_used: 1_000_000, total_available: 4_000_000, unlimited_quota: false, ...data },
      },
    },
  ])

const authOf = (extra = {}) => async () => ({
  site: SITE,
  key: "sk-x",
  accountId: "quota-manager#abc123",
  metadata: { site: SITE, kind: "new-api", name: "我的中转", ...extra },
})

test("usage：new-api 卡片给结构化额度（窗口 + 余额），不塞长句", async () => {
  const card = await usageFor(authOf(), { directory: DIR, accountId: "quota-manager#abc123", fetchImpl: newApiFetch() })
  assert.equal(card.user, "我的中转")
  assert.equal(card.balance, "$8")
  assert.equal(card.error, undefined)
  assert.equal(card.windows.length, 1)
  assert.equal(card.windows[0].used, 20)
  // 没有真套餐时不给 plan：给了 plan 会挡住 magpie 的余额卡分类
  assert.equal(card.plan, undefined)
  // 卡片里只有结构化字段，不该有一长串“站点：… · 类型：…”的句子
  assert.ok(!/站点：|类型：|上次/.test(JSON.stringify(card)))
})

test("usage：balance 是 magpie 能解析的金额（没有百分号、没有多余文字）", async () => {
  const card = await usageFor(authOf(), { directory: DIR, accountId: "quota-manager#abc123", fetchImpl: newApiFetch() })
  assert.ok(card.balance, "应当有余额")
  assert.ok(!card.balance.includes("%"), `余额里不能有 %：${card.balance}`)
  // magpie 的 BalanceNumber 取第一个数字串
  assert.match(card.balance, /-?\d[\d,]*(?:\.\d+)?/)
})

test("usage：令牌不限额又查不到用户额度时，只说「无限」，不编一个 0 余额", async () => {
  const card = await usageFor(authOf(), {
    directory: DIR,
    accountId: "quota-manager#abc123",
    fetchImpl: newApiFetch({ unlimited_quota: true, total_granted: -1, total_used: 0, total_available: 0 }),
  })
  assert.equal(card.balance, "无限")
  // 没有数字就不是一个可比较的余额：magpie 的额度提醒不会误报
  assert.equal(card.windows, undefined)
})

test("usage：备注名和站点认出来的账号名一起显示，同名时不重复", async () => {
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/status"), body: statusBody },
    { match: (url) => url.endsWith("/api/usage/token/"), body: { code: true, data: { name: "a@b.c", total_granted: 1, total_used: 0, total_available: 1, unlimited_quota: false } } },
  ])
  // 账号里的备注名和站点返回的令牌名相同：只显示一次
  const card = await usageFor(async () => ({ site: SITE, key: "sk-x", metadata: { site: SITE, kind: "new-api", name: "a@b.c" } }), {
    directory: DIR,
    accountId: "quota-manager#x",
    fetchImpl: f,
  })
  assert.equal(card.user, "a@b.c")
})

test("usage：站点类型没记过时现探一次，认不出来就如实说", async () => {
  const f = fakeFetch([{ match: () => true, status: 404, text: "not found" }])
  const card = await usageFor(
    async () => ({ site: "https://unknown.example.com", key: "sk-x", metadata: { site: "https://unknown.example.com" } }),
    { directory: DIR, accountId: "quota-manager#u", fetchImpl: f },
  )
  assert.match(card.error, /没认出/)
})

test("usage：连不上时把主机名写进报错，看得出是哪个站点", async () => {
  const f = fakeFetch([{ match: () => true, error: "getaddrinfo ENOTFOUND", code: "ENOTFOUND" }])
  const card = await usageFor(authOf(), { directory: DIR, accountId: "quota-manager#abc123", fetchImpl: f })
  assert.match(card.error, /newapi\.example\.com/)
  assert.match(card.error, /DNS/)
})

test("usage：令牌失效时把 signIn 交给 magpie，让它把账号标成要重新登录", async () => {
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/status"), body: statusBody },
    { match: (url) => url.endsWith("/api/usage/token/"), status: 401, body: { code: false, message: "unauthorized" } },
  ])
  const card = await usageFor(authOf(), { directory: DIR, accountId: "quota-manager#abc123", fetchImpl: f })
  assert.equal(card.signIn, "expired")
})

test("usage：账号里没记站点地址时不发请求", async () => {
  const f = fakeFetch([])
  const card = await usageFor(async () => ({ key: "sk-x" }), { directory: DIR, accountId: "quota-manager#z", fetchImpl: f })
  assert.match(card.error, /站点/)
  assert.equal(f.calls.length, 0)
})

test("usage：记下的类型读不出东西时换另一家读法（公开接口被网关挡住的站点也能读到）", async () => {
  const site = "https://gated.example.com"
  const f = fakeFetch([
    // new-api 的令牌接口在这台网关上是 404；sub2api 的 /v1/usage 才有货
    { match: (url) => url.endsWith("/api/usage/token/"), status: 404, text: "not found" },
    { match: (url) => url.endsWith("/api/status"), status: 404, text: "not found" },
    { match: (url) => url.endsWith("/v1/usage"), body: { mode: "unrestricted", remaining: 3.5, balance: 3.5, unit: "USD" } },
  ])
  const card = await usageFor(async () => ({ site, key: "sk-x", metadata: { site, kind: "new-api" } }), {
    directory: DIR,
    accountId: "quota-manager#gate",
    fetchImpl: f,
  })
  assert.equal(card.balance, "$3.5")
  assert.equal(card.error, undefined)
})

test("usage：两家都说“不认这个凭据”时，按凭据失效报（不吞成“没认出来”）", async () => {
  const site = "https://auth.example.com"
  const f = fakeFetch([
    { match: (url) => url.endsWith("/api/usage/token/"), status: 401, body: { code: false, message: "unauthorized" } },
    { match: (url) => url.endsWith("/api/status"), status: 404, text: "not found" },
    { match: (url) => url.endsWith("/v1/usage"), status: 401, body: { error: "Invalid API key" } },
  ])
  const card = await usageFor(async () => ({ site, key: "sk-x", metadata: { site, kind: "new-api" } }), {
    directory: DIR,
    accountId: "quota-manager#auth",
    fetchImpl: f,
  })
  assert.equal(card.signIn, "expired")
  assert.match(card.error, /令牌|密钥/)
})

test("usage：错误结果只缓存两分钟，正常结果缓存五分钟", async () => {
  resetUsageCache()
  resetDetectCache()
  resetRateLimits()
  const site = "https://cache.example.com"
  const ok = newApiFetch()
  const getAuth = async () => ({ site, key: "sk-x", metadata: { site, kind: "new-api" } })
  await usageFor(getAuth, { directory: DIR, accountId: "quota-manager#c", fetchImpl: ok })
  // 注入 fetchImpl 时本来就不缓存；这里只验证卡片本身可复用
  const again = await usageFor(getAuth, { directory: DIR, accountId: "quota-manager#c", fetchImpl: ok })
  assert.deepEqual(again.balance, "$8")
  assert.equal(ok.calls.length, 4, "注入 fetchImpl 时不缓存，两轮共四次请求")
})
