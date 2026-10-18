// new-api 站点的签到行为。
//
// 覆盖用户要求的那几种情况：签到成功 / 今日已签 / 管理员没开 / 没适配 /
// 令牌失效 / 站点挂掉 / 要人机验证。

import test from "node:test"
import assert from "node:assert/strict"

import { checkinNewApi, checkinSite, detectSite, newApiStatus } from "../lib/checkin.mjs"
import { fakeFetch, countCalls } from "./helpers.mjs"

const SITE = "https://newapi.example.com"

const statusOn = {
  match: (url) => url.endsWith("/api/status"),
  body: { success: true, data: { version: "0.9.7", system_name: "某个中转站", checkin_enabled: true } },
}
const statusOff = {
  match: (url) => url.endsWith("/api/status"),
  body: { success: true, data: { version: "0.9.7", checkin_enabled: false } },
}

/** 签到状态接口（GET /api/user/checkin?month=…）。 */
const statusRead = (extra) => ({
  match: (url, init) => url.includes("/api/user/checkin") && url.includes("month=") && String(init?.method ?? "GET").toUpperCase() === "GET",
  ...extra,
})

/** 签到接口（POST /api/user/checkin）。 */
const checkinPost = (extra) => ({
  match: (url, init) => url.endsWith("/api/user/checkin") && String(init?.method ?? "GET").toUpperCase() === "POST",
  ...extra,
})

/** new-api 的签到状态接口回复。 */
function checkinStatus({ enabled = true, today = false, record, min = 1000, max = 5000, disabled = false } = {}) {
  if (disabled) {
    return statusRead({ status: 200, body: { success: false, message: "Check-in feature is not enabled" } })
  }
  return statusRead({
    body: {
      success: true,
      data: {
        enabled,
        min_quota: min,
        max_quota: max,
        stats: {
          total_quota: 12345,
          total_checkins: 7,
          checkin_count: 3,
          checked_in_today: today,
          records: record ? [record] : [],
        },
      },
    },
  })
}

test("认站点：/api/status 有 checkin_enabled 就是 new-api", async () => {
  const f = fakeFetch([statusOn])
  const d = await detectSite(SITE, { token: "nap_x", fetchImpl: f })
  assert.equal(d.kind, "new-api")
  assert.equal(d.checkinEnabled, true)
})

test("签到：全新一天，签到成功并带回奖励", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus({ today: false }),
    checkinPost({ body: { success: true, message: "签到成功", data: { quota_awarded: 2300, checkin_date: "2026-10-18" } } }),
  ])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 2300)
  assert.match(r.message, /2300/)
})

test("签到：今天已经签过了，走 status 就返回 done，不再发 POST", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus({ today: true, record: { checkin_date: todayBeijing(), quota_awarded: 1800 } }),
  ])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "done")
  assert.equal(r.credit, 1800)
  assert.equal(countCalls(f, "/api/user/checkin"), 1, "只读了状态，没有 POST 签到")
})

test("签到：管理员没开签到 → inactive，提示点明是站点管理员关的", async () => {
  const f = fakeFetch([statusOff, checkinStatus({ disabled: true })])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没有开启签到/)
  assert.match(r.message, /管理员/)
  assert.equal(countCalls(f, "/api/user/self"), 0)
})

test("签到：站点存在但不是 new-api/sub2api → 如实说“没适配”", async () => {
  const f = fakeFetch([
    { match: "/api/status", status: 404, text: "not found" },
    { match: "/api/user/checkin", status: 404, text: "not found" },
    { match: "/api/v1/settings/public", status: 404, text: "not found" },
    { match: "/api/v1/auth/me", status: 404, text: "not found" },
    { match: "/api/v1/", status: 404, text: "not found" },
  ])
  const r = await checkinSite(SITE, { key: "sk-abc" }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没适配/)
  assert.match(r.message, /newapi\.example\.com/)
})

test("签到：站点连不上（DNS 失败）→ failed，原话说清原因", async () => {
  const f = fakeFetch([{ match: () => true, error: "getaddrinfo ENOTFOUND newapi.example.com", code: "ENOTFOUND" }])
  const r = await checkinSite(SITE, { key: "sk-abc" }, { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /域名解析不了|连不上/)
})

test("签到：访问令牌失效 → failed，并告诉用户去哪里重新生成", async () => {
  const f = fakeFetch([
    statusOn,
    { match: "/api/user/checkin", status: 401, body: { success: false, message: "Unauthorized" } },
  ])
  const r = await checkinNewApi(SITE, "nap_stale", { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /访问令牌/)
  assert.match(r.message, /重新生成|设置/)
})

test("签到：POST 时管理员把签到关了 → inactive（而不是笼统的失败）", async () => {
  const f = fakeFetch([
    statusOn,
    // 读状态那会儿还能用，POST 的时候管理员关掉了
    checkinStatus({ today: false }),
    checkinPost({ status: 200, body: { success: false, message: "Check-in feature is not enabled" } }),
  ])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没有开启签到/)
})

test("签到：POST 回“今天已签” → done", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus({ today: false }),
    checkinPost({ status: 200, body: { success: false, message: "Already checked in today" } }),
  ])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("签到：站点挂了（521）→ failed，把状态码原样报出来", async () => {
  const f = fakeFetch([{ match: () => true, status: 521, text: "Web server is down" }])
  const r = await checkinSite(SITE, { key: "sk-abc" }, { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /521|连不上/)
})

test("签到：要人机验证 → captcha，绝不尝试破解", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus({ today: false }),
    checkinPost({ status: 403, body: { success: false, message: "Turnstile verification failed" } }),
  ])
  const r = await checkinNewApi(SITE, "nap_token", { fetchImpl: f })
  assert.equal(r.outcome, "captcha")
  assert.match(r.message, /人机验证|手动/)
})

test("没带令牌的 new-api 签到：明确告诉用户要访问令牌", async () => {
  const f = fakeFetch([statusOn])
  const r = await checkinSite(SITE, {}, { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /访问令牌/)
})

test("状态读取：额度字段解析正确", async () => {
  const f = fakeFetch([
    statusOn,
    checkinStatus({ today: true, record: { checkin_date: todayBeijing(), quota_awarded: 999 }, min: 100, max: 200 }),
  ])
  const st = await newApiStatus(SITE, "nap_token", { fetchImpl: f })
  assert.equal(st.enabled, true)
  assert.equal(st.today, true)
  assert.equal(st.todayCredit, 999)
  assert.equal(st.totalCheckins, 7)
  assert.equal(st.totalQuota, 12345)
  assert.equal(st.minQuota, 100)
  assert.equal(st.maxQuota, 200)
})

/** 北京时间的今天，YYYY-MM-DD。 */
function todayBeijing() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}
