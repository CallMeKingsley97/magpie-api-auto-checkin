// 别把用户的站点当成练手靶子。
//
// Usage 卡片会被 magpie 反复刷新。这里覆盖三件事：
//  - 站点回 429 后一段时间内不再请求它（含 Retry-After）；
//  - 站点类型探测有缓存，刷新卡片不会把整套路径重试一遍；
//  - 卡片结果有缓存，连续刷新只发一轮请求。

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { requestJson, resetRateLimits, rateLimitSeconds } from "../lib/core.mjs"
import { detectSite, resetDetectCache } from "../lib/detect.mjs"
import { usageFor, resetUsageCache } from "../lib/usage.mjs"
import { fakeFetch } from "./helpers.mjs"

const SITE = "https://ratelimit.example.com"

beforeEach(() => {
  resetRateLimits()
  resetDetectCache()
  resetUsageCache()
})

test("429 之后：退避窗口内同一个站点一次请求都不再发", async () => {
  const f = fakeFetch([{ match: () => true, status: 429, body: { message: "rate limited" }, headers: { "Retry-After": "120" } }])
  const first = await requestJson(SITE, "/api/status", { fetchImpl: f })
  assert.equal(first.status, 429)
  assert.equal(f.calls.length, 1)
  assert.ok(rateLimitSeconds(SITE) > 100)

  const second = await requestJson(SITE, "/api/usage/token/", { fetchImpl: f })
  assert.equal(second.throttled, true)
  assert.equal(f.calls.length, 1, "退避期内不该再有网络请求")
})

test("没有 Retry-After 时按递增退避，且不会无限长", async () => {
  const f = fakeFetch([{ match: () => true, status: 429, body: {} }])
  await requestJson(SITE, "/a", { fetchImpl: f })
  const first = rateLimitSeconds(SITE)
  assert.ok(first >= 55 && first <= 65, `第一次退避该是 60 秒左右，实际 ${first}`)

  const now = Date.now
  Date.now = () => now() + first * 1000 + 1000
  try {
    const again = fakeFetch([{ match: () => true, status: 429, body: {} }])
    await requestJson(SITE, "/b", { fetchImpl: again })
    assert.ok(rateLimitSeconds(SITE) > first, "第二次限流该退得更久")
    assert.ok(rateLimitSeconds(SITE) <= 15 * 60, "退避不该超过 15 分钟")
  } finally {
    Date.now = now
  }
})

test("429 之后读额度不再发请求，卡片如实说被限流", async () => {
  const f = fakeFetch([
    { match: (url) => url.includes("/api/status"), status: 429, headers: { "Retry-After": "120" }, body: {} },
    { match: (url) => url.endsWith("/api/usage/token/"), status: 429, headers: { "Retry-After": "120" }, body: {} },
  ])
  const card = await usageFor(
    async () => ({ site: SITE, key: "sk-x", metadata: { site: SITE, kind: "new-api" } }),
    { directory: "/tmp/quota-manager-rate-test", accountId: "quota-manager", fetchImpl: f },
  )
  assert.ok(rateLimitSeconds(SITE) > 0)
  assert.match(card.error ?? "", /限流|429/)

  const before = f.calls.length
  await usageFor(async () => ({ site: SITE, key: "sk-x", metadata: { site: SITE, kind: "new-api" } }), {
    directory: "/tmp/quota-manager-rate-test",
    accountId: "quota-manager",
    fetchImpl: f,
  })
  assert.equal(f.calls.length, before, "退避期内不该再碰这个站点")
})

test("usage 卡片同账号同站点会缓存：连续刷新只发一轮请求", async () => {
  // 用全局 fetch 模拟真实调用：注入 fetchImpl 的路径本来就不缓存
  const f = fakeFetch([
    {
      match: (url) => url.endsWith("/api/status"),
      body: { success: true, data: { quota_per_unit: 500000, quota_display_type: "USD" } },
    },
    {
      match: (url) => url.endsWith("/api/usage/token/"),
      body: {
        code: true,
        data: { name: "default", total_granted: 5000000, total_used: 1000000, total_available: 4000000, unlimited_quota: false, expires_at: 0 },
      },
    },
  ])
  const realFetch = globalThis.fetch
  globalThis.fetch = f
  try {
    const getAuth = async () => ({ site: SITE, key: "sk-x", metadata: { site: SITE, kind: "new-api" } })
    const a = await usageFor(getAuth, { directory: "/tmp/quota-manager-rate-test", accountId: "quota-manager" })
    const callsAfterFirst = f.calls.length
    const b = await usageFor(getAuth, { directory: "/tmp/quota-manager-rate-test", accountId: "quota-manager" })
    assert.equal(f.calls.length, callsAfterFirst, "第二次刷新不该再发请求")
    assert.deepEqual(b, a)
    assert.equal(b.balance, "$8")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("认不出来的站点也会缓存探测结果，不会每次刷新都重试", async () => {
  const f = fakeFetch([{ match: () => true, status: 404, text: "not found" }])
  const realFetch = globalThis.fetch
  globalThis.fetch = f
  try {
    assert.equal(await detectSite(SITE), undefined)
    const callsAfterFirst = f.calls.length
    assert.ok(callsAfterFirst > 1)
    assert.equal(await detectSite(SITE), undefined)
    assert.equal(f.calls.length, callsAfterFirst, "第二次探测应该命中缓存")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("连不上（DNS 失败）不缓存：站点恢复后马上能重新认出来", async () => {
  const down = fakeFetch([{ match: () => true, error: "getaddrinfo ENOTFOUND", code: "ENOTFOUND" }])
  const up = fakeFetch([
    {
      match: (url) => url.endsWith("/api/status"),
      body: { success: true, data: { quota_per_unit: 500000 } },
    },
  ])
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = down
    assert.equal(await detectSite(SITE), undefined)
    globalThis.fetch = up
    const d = await detectSite(SITE)
    assert.equal(d?.kind, "new-api")
  } finally {
    globalThis.fetch = realFetch
  }
})
