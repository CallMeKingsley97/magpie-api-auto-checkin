// Usage 卡片：magpie 界面上每个账号看到的那张小卡。
//
// 卡片只该放三样东西：账号（user）、站点类型（plan）、余额（balance）。
// 签到结果由 magpie 自己在卡片下面画一行（plugin-checkin.json），卡片里
// 再写一遍就会变成一长串“站点：… · 类型：… · 今天签到拿了：…”的文字墙。

import test from "node:test"
import assert from "node:assert/strict"

import { usageFor } from "../lib/usage.mjs"
import { fakeFetch, countCalls } from "./helpers.mjs"

const SITE = "https://newapi.example.com"

const statusOn = {
  match: (url) => url.endsWith("/api/status"),
  body: { success: true, data: { version: "0.9.7", checkin_enabled: true } },
}

/** new-api 的签到状态：有当月记录。 */
const checkinStatus = (extra = {}) => ({
  match: (url, init) =>
    url.includes("/api/user/checkin?month=") && String(init?.method ?? "GET").toUpperCase() === "GET",
  body: {
    success: true,
    data: {
      enabled: true,
      stats: {
        total_quota: 12345,
        total_checkins: 7,
        checked_in_today: false,
        records: [{ checkin_date: "2026-10-01", quota_awarded: 1500 }],
      },
    },
  },
  ...extra,
})

/** new-api 的账号信息（余额在这里）。 */
const selfInfo = (data) => ({
  match: (url) => url.endsWith("/api/user/self"),
  body: { success: true, data },
})

/** 一个空目录，state.json 读不到就是空状态。 */
const DIR = "/tmp/auto-checkin-usage-test"

test("usage：new-api 卡片给站点类型、账号名和余额，不再塞长句", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus(),
    selfInfo({ username: "kingsley", quota: 500000, used_quota: 1200 }),
  ])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_x", metadata: { site: SITE } }), {
    directory: DIR,
    accountId: "auto-checkin#abc123",
    fetchImpl: f,
  })
  assert.equal(card.plan, "new-api")
  assert.equal(card.user, "newapi.example.com · kingsley")
  assert.equal(card.balance, "500000 额度")
  assert.equal(card.error, undefined)
  // magpie 的签到行自己会显示“今天签没签”，卡片里不该再重复
  assert.equal(card.windows, undefined)
  assert.ok(!/站点：|类型：|上次签到/.test(JSON.stringify(card)))
})

test("usage：余额是小数时保留两位，不显示成 0", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus(),
    selfInfo({ user: { username: "someone", quota: "12.5" } }),
  ])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  assert.equal(card.balance, "12.5 额度")
  assert.equal(card.user, "newapi.example.com · someone")
})

test("usage：余额接口挂了，卡片不整张变错误（签到状态照样读到）", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus(),
    { match: (url) => url.endsWith("/api/user/self"), status: 500, body: { success: false, message: "internal error" } },
  ])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  assert.equal(card.plan, "new-api")
  // 余额读不出来是余额的事：不伪装成签到失败，也不在卡片上亮红字
  // （分支站的 /api/user/self 常常被改过）
  assert.equal(card.error, undefined)
  assert.equal(card.balance, "")
  assert.equal(card.signIn, undefined)
})

test("usage：令牌被拒 → signIn=expired，magpie 会把账号标成要重新登录", async () => {
  const f = fakeFetch([
    statusOn,
    // 签到状态接口还在，但 /api/user/self 说令牌不认
    checkinStatus(),
    {
      match: (url) => url.endsWith("/api/user/self"),
      status: 401,
      body: { success: false, message: "Unauthorized" },
    },
  ])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_stale" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  // 余额接口被拒不等于签到接口被拒：不能因为余额读不到就把账号标成登出
  assert.equal(card.signIn, undefined)
  assert.equal(card.error, undefined)
})

test("usage：签到状态接口和余额接口都说令牌不认 → signIn=expired", async () => {
  const f = fakeFetch([
    statusOn,
    {
      match: (url) => url.includes("/api/user/checkin?month="),
      status: 401,
      body: { success: false, message: "Unauthorized" },
    },
    {
      match: (url) => url.endsWith("/api/user/self"),
      status: 401,
      body: { success: false, message: "Unauthorized" },
    },
  ])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_stale" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  assert.equal(card.signIn, "expired")
  assert.match(card.error, /访问令牌/)
})

test("usage：站点连不上时，报错里带主机名（卡片上没有别的地方能看出来）", async () => {
  const f = fakeFetch([{ match: () => true, error: "getaddrinfo ENOTFOUND newapi.example.com", code: "ENOTFOUND" }])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  assert.match(card.error, /newapi\.example\.com/)
  assert.match(card.error, /连不上/)
})

test("usage：账号里没有站点地址时，说清要重新添加", async () => {
  const card = await usageFor(async () => ({ key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
  })
  assert.match(card.error, /移除后重新添加/)
  assert.equal(card.user, "auto-checkin")
})

test("usage：sub2api 卡片用邮箱当账号，余额带站点单位", async () => {
  const f = fakeFetch([
    {
      match: (url) => url.includes("/api/v1/settings/public"),
      body: { code: 0, data: { site_name: "site" } },
    },
    {
      match: (url) => url.endsWith("/api/v1/auth/me"),
      body: { code: 0, data: { email: "me@example.com", balance: { amount: 5.2, unit: "USD" } } },
    },
  ])
  const card = await usageFor(async () => ({ site: "https://sub2.example.com", key: "tok" }), {
    directory: DIR,
    accountId: "auto-checkin#s1",
    fetchImpl: f,
  })
  assert.equal(card.plan, "sub2api")
  assert.equal(card.user, "sub2.example.com · me@example.com")
  assert.equal(card.balance, "5.2 USD")
})

test("usage：订阅页按“余额卡”显示（有 balance、没 windows），不是空白用量卡", async () => {
  const f = fakeFetch([statusOn, checkinStatus(), selfInfo({ username: "u", quota: 42 })])
  const card = await usageFor(async () => ({ site: SITE, key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  // magpie 的 Usage 页把 balance && !windows.length 的卡当余额卡排在最后；
  // 带上 plan 也不算“套餐卡”（keyCards 只合并 windows 卡）。这条测试
  // 防止以后又往卡片里塞 windows，把它变回一张空的用量卡。
  assert.ok(card.balance)
  assert.equal(card.windows, undefined)
})

test("usage：只读用量，不误发签到请求", async () => {
  const f = fakeFetch([statusOn, checkinStatus(), selfInfo({ username: "u", quota: 1 })])
  await usageFor(async () => ({ site: SITE, key: "nap_x" }), {
    directory: DIR,
    accountId: "auto-checkin",
    fetchImpl: f,
  })
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0)
  assert.equal(countCalls(f, "/api/user/checkin"), 1, "只读当月状态，不 POST 签到")
})
