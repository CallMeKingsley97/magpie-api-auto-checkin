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

test("FreeAPI：状态接口 + 签到 POST", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin?timezone=") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_in_today: false, min_amount: 10, max_amount: 20 }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST",
      body: envelope({ amount: 15 }),
    },
  ])
  const r = await checkinSite(SITE, { access: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.x", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 15)
  // 时区跟着站点前端只加在 GET 上；POST 用站点原生的干净路径
  const get = f.calls.find((c) => c.method === "GET" && c.path.startsWith("/api/v1/user/checkin"))
  assert.match(decodeURIComponent(get.url), /timezone=Asia\/Shanghai/)
  const post = f.calls.find((c) => c.method === "POST")
  assert.equal(post.path, "/api/v1/user/checkin")
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

// ---- 共用的 /api/v1/user/checkin/status 路径 ----------------------------------
//
// Genius Programmer 和 Clawhud 读同一个路径，只有字段名不同。认错了就会把
// A 家的签到发到 B 家的接口上，所以这两条必须分开认。

test("Genius / Clawhud 共用状态路径：today_checked_in 归 Genius", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, today_checked_in: false, recent_records: [] }),
    },
    { match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST", body: envelope({ new_reward: true, reward_amount: 2.5 }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 2.5)
})

test("Genius / Clawhud 共用状态路径：checked_in_today + total_count 归 Clawhud", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_in_today: false, total_count: 9, total_amount: 30 }),
    },
    { match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST", body: envelope({ checked_in_today: true, today_amount: 0.8 }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 0.8)
})

test("Clawhud：重复签到回 409 + CHECKIN_ALREADY_DONE → done（不靠文案）", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_in_today: false, total_count: 9, total_amount: 30 }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST",
      status: 409,
      body: { code: 409, message: "duplicate", reason: "CHECKIN_ALREADY_DONE" },
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("Genius：new_reward=false 的成功回包也算“今天已签”，不重复算奖励", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, today_checked_in: false, recent_records: [] }),
    },
    { match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST", body: envelope({ new_reward: false }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

// ---- Daigua / Sidrune ------------------------------------------------------

test("Daigua：admin_disabled 是管理员关了，不是“今天签过”", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url) => url.includes("/api/v1/checkin/status"),
      body: envelope({ enabled: false, can_checkin: false, luck_enabled: false, unavailable_reason: "admin_disabled" }),
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没有开启签到/)
})

test("Daigua：签到成功，POST 发空对象（原生页面就是空 body）", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/checkin/status"), body: envelope({ enabled: true, can_checkin: true, luck_enabled: false }) },
    { match: (url, init) => url.endsWith("/api/v1/checkin") && init?.method === "POST", body: envelope({ checkin_type: "normal", reward_amount: 1.2 }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 1.2)
  const post = f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/checkin")
  assert.equal(post.body, "{}")
})

test("Sidrune：eligible=false 是没资格，不是签到关了", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/welfare/profile"), body: envelope({ enabled: true, eligible: false, checked_in_today: false }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "ineligible")
})

test("Sidrune：站点级开关关了优先报“管理员关了”，不往资格上猜", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/welfare/profile"), body: envelope({ enabled: false, eligible: false, checked_in_today: false }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
  assert.match(r.message, /没有开启签到/)
})

test("Sidrune：签到带上连续天数和里程碑奖励", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/welfare/profile"), body: envelope({ enabled: true, eligible: true, checked_in_today: false }) },
    { match: (url, init) => url.endsWith("/api/v1/welfare/checkin") && init?.method === "POST", body: envelope({ reward_amount: 0.5, milestone_bonus: 1, streak_day: 7 }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 0.5)
  assert.equal(r.streak, 7)
})

// ---- 两套独立协议 -----------------------------------------------------------

test("Denxio：begin → 等待 → claim 两段式签到", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/tbe-sponsor-checkin/status"), body: envelope({ normal_done: false, config: { normal_checkin_enabled: true } }) },
    {
      match: (url, init) => url.includes("/api/v1/tbe-sponsor-checkin/normal/begin") && init?.method === "POST",
      body: envelope({ token: "challenge-1", wait_seconds: 0 }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/tbe-sponsor-checkin/normal/claim") && init?.method === "POST",
      body: envelope({ record: { amount: 0.3 } }),
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 0.3)
  const claim = f.calls.find((c) => c.path.endsWith("/normal/claim"))
  assert.equal(JSON.parse(claim.body).token, "challenge-1")
})

test("Denxio：重复领取的 reason 码 → done", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/tbe-sponsor-checkin/status"), body: envelope({ normal_done: false, config: { normal_checkin_enabled: true } }) },
    { match: (url, init) => url.includes("/normal/begin") && init?.method === "POST", body: envelope({ token: "c1", wait_seconds: 0 }) },
    {
      match: (url, init) => url.endsWith("/normal/claim") && init?.method === "POST",
      status: 409,
      body: { code: 409, message: "done", reason: "TBE_SPONSOR_CHECKIN_ALREADY_DONE" },
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("Denxio：管理员关掉（normal_checkin_enabled=false）→ inactive", async () => {
  const f = fakeFetch([
    publicSettings,
    { match: (url) => url.includes("/api/v1/tbe-sponsor-checkin/status"), body: envelope({ normal_done: false, config: { normal_checkin_enabled: false } }) },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "inactive")
})

test("AI-ROUTER：/api/v1/user/daily-checkin 一条路径读和领", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/daily-checkin") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_today: false, eligible: true }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/user/daily-checkin") && init?.method === "POST",
      body: envelope({ checked_today: true, reward_amount: 0.05 }),
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 0.05)
})

test("AI-ROUTER：没资格（eligible=false）就不发领取请求", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/daily-checkin") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_today: false, eligible: false }),
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  // 站点开着签到，但账号没到门槛：这是“没资格”，不是“管理员关了”
  assert.equal(r.outcome, "ineligible")
  assert.equal(countCalls(f, "/api/v1/user/daily-checkin"), 1)
})

test("AI-ROUTER：重复领取 409 DAILY_CHECKIN_CLAIMED → done", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/daily-checkin") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_today: false, eligible: true }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/user/daily-checkin") && init?.method === "POST",
      status: 409,
      body: { code: 409, message: "claimed", reason: "DAILY_CHECKIN_CLAIMED" },
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

// ---- 失败后回读 -------------------------------------------------------------

test("签到 POST 回了个看不懂的错误，但回读状态已经签上了 → 如实报 done", async () => {
  let statusCalls = 0
  const f = fakeFetch([
    publicSettings,
    {
      // 第一次读：没签；POST 之后再读：已签
      match: (url, init) => url.includes("/api/v1/redeem/checkin/status") && String(init?.method ?? "GET").toUpperCase() === "GET",
      respond: () => ({
        body: envelope({ enabled: true, checked_in_today: statusCalls++ > 0, reward_min: 1, reward_max: 2 }),
      }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/redeem/checkin") && init?.method === "POST",
      status: 502,
      text: "<html>bad gateway</html>",
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "done")
})

test("FreeAPI 这类分支：HTTP 200 但 code 是字符串 UNAUTHORIZED → 按失败处理", async () => {
  const f = fakeFetch([
    publicSettings,
    {
      match: (url, init) => url.includes("/api/v1/user/checkin?timezone=") && String(init?.method ?? "GET").toUpperCase() === "GET",
      body: envelope({ enabled: true, checked_in_today: false, min_amount: 1, max_amount: 2 }),
    },
    {
      match: (url, init) => url.endsWith("/api/v1/user/checkin") && init?.method === "POST",
      // 传输级失败时站点把 code 换成字符串，HTTP 仍是 200
      body: { code: "UNAUTHORIZED", message: "未登录", reason: "UNAUTHORIZED" },
    },
  ])
  const r = await checkinSite(SITE, { access: "tok", site: SITE }, { fetchImpl: f })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /登录态|未登录/)
})
