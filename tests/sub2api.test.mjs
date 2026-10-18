// sub2api 站点的登录与签到。
//
// sub2api 有一堆分支站，签到接口各不一样；这里挑几家典型的覆盖：
// Sub2API Pro / FreeAPI / ToolCode / Hiyo / 小白Code，以及登录、
// 刷新、已签、管理员关闭、验证码、令牌过期几种结果。

import test from "node:test"
import assert from "node:assert/strict"

import { checkinSite, detectSite, loginSub2Api, refreshSub2ApiAuth } from "../lib/checkin.mjs"
import { fakeFetch, countCalls } from "./helpers.mjs"

const SITE = "https://sub2.example.com"

/** sub2api 的公开设置接口，用来认站点。 */
const publicSettings = { match: (url) => url.includes("/api/v1/settings/public"), body: { code: 0, message: "ok", data: { site_name: "某个中转站" } } }

const envelope = (data, extra = {}) => ({ code: 0, message: "ok", data, ...extra })

test("认站点：/api/v1/settings/public 答了就是 sub2api", async () => {
  const f = fakeFetch([publicSettings])
  const d = await detectSite(SITE, { fetchImpl: f })
  assert.equal(d.kind, "sub2api")
})

test("登录：拿到 access/refresh，账号名用邮箱", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.endsWith("/api/v1/auth/login") && init?.method === "POST",
      body: envelope({
        access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x",
        refresh_token: "rt-123",
        expires_in: 3600,
        user: { id: 42, email: "me@example.com" },
      }),
    },
  ])
  const t = await loginSub2Api(SITE, { email: "me@example.com", password: "pw" }, { fetchImpl: f })
  assert.equal(t.access.startsWith("eyJ"), true)
  assert.equal(t.refresh, "rt-123")
  assert.equal(t.accountId, "me@example.com")
  assert.equal(t.uid, "42")
  assert.ok(t.expires > Date.now() + 3500 * 1000)
})

test("登录：要人机验证（Turnstile）时明确说清，不尝试破解", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.endsWith("/api/v1/auth/login"), status: 400, body: { code: 4001, message: "Turnstile verification required" } },
  ])
  await assert.rejects(
    () => loginSub2Api(SITE, { email: "me@example.com", password: "pw" }, { fetchImpl: f }),
    (e) => {
      assert.match(e.message, /人机验证|Turnstile/i)
      return true
    },
  )
})

test("Sub2API Pro：读状态 + 签到成功 + 拿回奖励", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/redeem/checkin/status"), body: envelope({ enabled: true, checked_in_today: false, reward_min: 1, reward_max: 5 }) },
    { match: (url, init) => url.endsWith("/api/v1/redeem/checkin") && init?.method === "POST", body: envelope({ amount: 3.5, total_reward: 12 }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 3.5)
  assert.match(r.message, /3\.5/)
})

test("Sub2API Pro：今天已经签过 → done", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/redeem/checkin/status"), body: envelope({ enabled: true, checked_in_today: true, reward_min: 1, reward_max: 5 }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("Sub2API Pro：管理员关了签到 → inactive（按 reason 认出来）", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/redeem/checkin/status"), body: envelope({ enabled: false, checked_in_today: false, unavailable_reason: "DAILY_CHECKIN_DISABLED" }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没有开启签到/)
})

test("Sub2API Pro：POST 回 409 DAILY_CHECKIN_ALREADY_DONE → done", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/redeem/checkin/status"), body: envelope({ enabled: true, checked_in_today: false }) },
    {
      match: (url, init) => url.endsWith("/api/v1/redeem/checkin") && init?.method === "POST",
      status: 409,
      body: { code: 4090, message: "already checked in", reason: "DAILY_CHECKIN_ALREADY_DONE" },
    },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("FreeAPI：状态接口 + 带时区的 POST", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin?timezone=") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_in_today: false, min_amount: 10, max_amount: 20 }),
    },
    {
      match: (url, init) => url.includes("/api/v1/user/checkin?timezone=") && init?.method === "POST",
      body: envelope({ amount: 15 }),
    },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 15)
  const post = f.calls.find((c) => c.method === "POST")
  assert.match(post.url, /timezone=Asia\/Shanghai/)
})

test("Hiyo：daily_claimed 已签 → done，不重复 claim", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/checkin?timezone="), body: envelope({ enabled: true, daily_claimed: true, daily_available: true, can_claim: false }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
  assert.equal(countCalls(f, "/api/v1/checkin") , 1)
})

test("Hiyo：门槛没达到（tokens_met=false）→ ineligible", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/checkin?timezone="), body: envelope({ enabled: true, daily_claimed: false, can_claim: false, tokens_met: false }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "ineligible")
})

test("ToolCode：engagement 状态 + 签到拿积分", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/engagement/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ checkin_enabled: true, checked_in_today: false, can_checkin: true }),
    },
    { match: (url, init) => url.endsWith("/api/v1/engagement/checkin") && init?.method === "POST", body: envelope({ points_reward: 5, total_points: 120 }) },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 5)
})

test("ToolCode：POST 409 CHECKIN_ALREADY_COMPLETED → done", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/engagement/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ checkin_enabled: true, checked_in_today: false, can_checkin: true }),
    },
    { match: (url, init) => url.endsWith("/api/v1/engagement/checkin") && init?.method === "POST", status: 409, body: { code: 409, message: "done", reason: "CHECKIN_ALREADY_COMPLETED" } },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("小白Code：/checkin/api 这套接口", async () => {
  const f = fakeFetch([
    { match: (url, init) => url.endsWith("/checkin/api/status") && String(init?.method ?? "GET").toUpperCase() === "GET", body: { ok: true, data: { signedToday: false, config: { enabled: true } } } },
    { match: (url, init) => url.endsWith("/checkin/api/checkin") && init?.method === "POST", body: { ok: true, data: { alreadyChecked: false, record: { reward_amount: 8 } } } },
  ])
  // 小白Code 没有 /api/v1/settings/public，走签到接口自身认站
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 8)
})

test("小白Code：管理员关了 → inactive", async () => {
  const f = fakeFetch([{ match: (url) => url.endsWith("/checkin/api/status"), body: { ok: true, data: { signedToday: false, config: { enabled: false } } } }])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
})

test("sub2api：认不出的站点，如实说“没适配”", async () => {
  const f = fakeFetch([{ match: () => true, status: 404, text: "not found" }])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没适配/)
})

test("sub2api：令牌过期但刷新成功，签到照样完成（并保存新令牌）", async () => {
  const saved = []
  const f = fakeFetch([
    publicSettings,
    {
      match: (url) => url.endsWith("/api/v1/auth/refresh"),
      body: envelope({ access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.y", refresh_token: "rt-2" }),
    },
    { match: (url) => url.includes("/api/v1/redeem/checkin/status"), body: envelope({ enabled: true, checked_in_today: false }) },
    { match: (url, init) => url.endsWith("/api/v1/redeem/checkin") && init?.method === "POST", body: envelope({ amount: 2 }) },
  ])
  const r = await checkinSite(
    SITE,
    { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDAwMDAwMDB9.x", refresh: "rt-1", expires: 1_000_000_000_000, site: SITE },
    { fetchImpl: f, save: async (a) => saved.push(a) },
  )
  assert.equal(r.outcome, "claimed")
  assert.equal(saved.length, 1)
  assert.equal(saved[0].refresh, "rt-2")
  assert.match(saved[0].access, /\.y$/)
})

test("sub2api：刷新被拒（登录态失效）→ failed，提示重新登录", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.endsWith("/api/v1/auth/refresh"), status: 401, body: { code: 401, message: "invalid refresh token" } },
  ])
  const r = await checkinSite(
    SITE,
    { access: "old", refresh: "rt-1", expires: 1_000_000_000_000, site: SITE },
    { fetchImpl: f },
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /重新登录|失效/)
})

test("sub2api：没登录态的账号，直接说清要重新登录", async () => {
  const f = fakeFetch([publicSettings])
  const r = await checkinSite(SITE, { site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /登录/)
})

test("刷新：令牌还早，不发刷新请求", async () => {
  const f = fakeFetch([{ match: () => true, status: 500, text: "不该被调用" }])
  const auth = { access: "a", refresh: "r", expires: Date.now() + 60 * 60 * 1000, site: SITE }
  const { renewed } = await refreshSub2ApiAuth(auth, { fetchImpl: f })
  assert.equal(renewed, false)
  assert.equal(f.calls.length, 0)
})
