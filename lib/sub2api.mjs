// sub2api（以及围绕它的分支站）的登录与额度读取。
//
// 站点给两把不同的钥匙，读法也不同：
//  - API 密钥（sk-…，就是 providers.json 里配的那把）→ GET /v1/usage。
//    这是 sub2api 为 CC Switch 这类客户端准备的接口，答的是“这个 key 还剩多少”：
//    quota_limited 模式给总额度和 5h/1d/7d 三个速率窗口，unrestricted 模式给
//    订阅套餐（日/周/月额度）或钱包余额。
//  - 登录令牌（邮箱密码登录拿到的 access token）→ GET /api/v1/user/profile。
//    它读的是用户资料里的余额；令牌快到期时先拿 refresh_token 续一次。
//
// 请求只发往用户自己配置的站点；日志和卡片里都不出现密钥。

import {
  SiteError,
  asRecord,
  jwtExpiryMs,
  messageOf,
  requestJson,
  siteLabel,
  siteRootOf,
  toAmount,
  unwrapData,
} from "./core.mjs"
import { formatNumber } from "./newapi.mjs"

const LOGIN_TIMEOUT = 15000

// /v1/usage 的回答里必有这几个字段之一；都没有就说明这不是 sub2api
const SUB2API_FIELDS = ["mode", "quota", "balance", "remaining", "planName", "subscription", "rate_limits", "usage"]
const isThrottled = (r) => r?.throttled === true || r?.status === 429
const isCaptcha = (s) => /turnstile|captcha|人机验证|验证码/i.test(String(s ?? ""))
const bearer = (token) => (token ? { Authorization: `Bearer ${String(token).trim()}` } : {})
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const iso = (v) => {
  if (v === undefined || v === null || v === "") return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** 登录 sub2api 站点，返回可以存进 magpie 的凭据。 */
export async function loginSub2Api(site, { email, password }, { fetchImpl } = {}) {
  const label = siteLabel(site)
  const r = await requestJson(site, "/api/v1/auth/login", {
    method: "POST",
    body: { email: String(email ?? "").trim(), password: String(password ?? "") },
    timeout: LOGIN_TIMEOUT,
    fetchImpl,
  })
  if (r.error) throw new SiteError(`${label} 连不上：${r.error}`, isThrottled(r) ? { kind: "rate" } : {})
  const data = asRecord(unwrapData(r.body)) ?? {}
  const access = String(data.access_token ?? data.accessToken ?? "").trim()
  const refresh = String(data.refresh_token ?? data.refreshToken ?? "").trim()
  if (!r.ok || !access) {
    const text = messageOf(r.body) || `HTTP ${r.status}`
    if (isCaptcha(text)) {
      throw new SiteError(`${label} 的登录要过人机验证（Turnstile），插件不破解验证码，请改用「sub2api 登录令牌」方式`, {
        kind: "captcha",
      })
    }
    throw new SiteError(`${label} 登录失败：${text}`, { kind: text ? "auth" : "other" })
  }
  const user = asRecord(data.user) ?? {}
  const expiresIn = toAmount(data.expires_in)
  return {
    access,
    refresh,
    // 不知道什么时候过期就是 0，别当成“现在过期”
    expires: jwtExpiryMs(access) || (expiresIn ? Date.now() + expiresIn * 1000 : 0),
    accountId: String(user.email ?? user.username ?? email ?? "").trim() || label,
    uid: String(user.id ?? "").trim(),
    site,
  }
}

// 站点没给过期时间时，令牌可能根本不会过期，也可能随时过期。这种情况下
// 每刷新一次卡片就换一次令牌，等于在轮询登录接口；限制成十分钟最多试一次。
const REFRESH_RETRY_MS = 10 * 60_000
const lastRefreshAt = new Map() // 站点根 -> 毫秒时间戳

/** 令牌快到期时用 refresh_token 换新的；返回 {auth, renewed}。 */
export async function refreshSub2ApiAuth(auth, { fetchImpl, save } = {}) {
  const refresh = String(auth?.refresh ?? "").trim()
  if (!refresh) return { auth, renewed: false }
  const expires = Number(auth?.expires) || jwtExpiryMs(auth?.access)
  if (expires && Date.now() < expires - 5 * 60 * 1000) return { auth, renewed: false }

  const site = auth.site
  if (!expires) {
    const key = siteRootOf(site)
    const last = lastRefreshAt.get(key) ?? 0
    if (Date.now() - last < REFRESH_RETRY_MS) return { auth, renewed: false }
    lastRefreshAt.set(key, Date.now())
  }

  const r = await requestJson(site, "/api/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: refresh },
    timeout: LOGIN_TIMEOUT,
    fetchImpl,
  })
  if (isThrottled(r)) throw new SiteError(`${siteLabel(site)} 限流了（刷新登录态失败）`, { kind: "rate" })
  if (r.error) throw new SiteError(`${siteLabel(site)} 连不上（刷新登录态失败）：${r.error}`)
  const data = asRecord(unwrapData(r.body)) ?? {}
  const access = String(data.access_token ?? data.accessToken ?? "").trim()
  if (!r.ok || !access) {
    throw new SiteError(`${siteLabel(site)} 的登录态失效了，需要重新登录：${messageOf(r.body) || `HTTP ${r.status}`}`, {
      kind: "auth",
    })
  }
  const nextExpiresIn = toAmount(data.expires_in)
  const next = {
    ...auth,
    access,
    refresh: String(data.refresh_token ?? data.refreshToken ?? refresh).trim(),
    expires: jwtExpiryMs(access) || (nextExpiresIn ? Date.now() + nextExpiresIn * 1000 : 0),
  }
  try {
    await save?.(next)
  } catch {}
  return { auth: next, renewed: true }
}

// ---- 额度 -------------------------------------------------------------------

const money = (n) => `$${formatNumber(n)}`

/** 一个美元额度窗口：used/limit 都是美元，magpie 自己画百分比。 */
function usdWindow(name, used, limit, resetsAt) {
  return {
    name,
    used: limit > 0 ? (used / limit) * 100 : 0,
    // magpie 的 amount / limit 只写两位小数，sub2api 的额度常见几分钱，
    // 那时只给 display（已经写好的文字）
    ...(limit >= 0.01 ? { amount: used, limit, unit: "USD" } : {}),
    display: `${money(used)} / ${money(limit)}`,
    ...(resetsAt ? { resetsAt } : {}),
  }
}

const WINDOW_NAMES = { "5h": "5 小时", "1d": "1 天", "7d": "7 天" }

/** GET /v1/usage 的回答 → 卡片字段。 */
export function cardOfUsage(u) {
  const usage = asRecord(u) ?? {}
  const windows = []
  const q = asRecord(usage.quota)
  let balance = ""
  if (q) {
    const limit = num(q.limit) ?? 0
    const used = num(q.used) ?? 0
    if (limit > 0) {
      windows.push(usdWindow("额度", used, limit))
      const left = num(q.remaining) ?? Math.max(0, limit - used)
      balance = money(Math.max(0, left))
    }
  }
  for (const rl of Array.isArray(usage.rate_limits) ? usage.rate_limits : []) {
    const limit = num(rl?.limit) ?? 0
    const used = num(rl?.used)
    if (!(limit > 0) || used === undefined) continue
    const name = WINDOW_NAMES[String(rl.window ?? "")] ?? String(rl.window ?? "速率")
    windows.push(usdWindow(name, used, limit, iso(rl.reset_at)))
  }

  const sub = asRecord(usage.subscription)
  let plan = ""
  if (sub) {
    for (const [name, usedKey, limitKey] of [
      ["每天", "daily_usage_usd", "daily_limit_usd"],
      ["每周", "weekly_usage_usd", "weekly_limit_usd"],
      ["每月", "monthly_usage_usd", "monthly_limit_usd"],
    ]) {
      const limit = num(sub[limitKey]) ?? 0
      const used = num(sub[usedKey])
      if (!(limit > 0) || used === undefined) continue
      windows.push(usdWindow(name, used, limit))
    }
    // 订阅套餐名只有在有窗口时才当 plan：一个孤零零的 plan 会让 magpie
    // 把卡片当“套餐卡”，余额行反而不画了
    if (windows.length) plan = String(usage.planName ?? "").trim()
  }

  if (!balance) {
    // 钱包余额和订阅剩余都走这个字段；currency 类的站点也可能只给 remaining
    const left = num(usage.balance) ?? num(usage.remaining)
    if (left !== undefined) balance = money(Math.max(0, left))
  }
  const until = iso(usage.expires_at) ?? iso(sub?.expires_at)
  return {
    ...(plan ? { plan } : {}),
    ...(balance ? { balance } : {}),
    ...(windows.length ? { windows } : {}),
    ...(until ? { until } : {}),
  }
}

/**
 * 读 sub2api 账号的额度。cred 是账号里存的凭据：
 * {key: providers.json 的 API 密钥, access, refresh, expires, site}。
 */
export async function readSub2Api(site, cred = {}, { fetchImpl, save } = {}) {
  const label = siteLabel(site)
  const key = String(cred.key ?? "").trim()
  // JWT 是登录令牌，不是网关的 API 密钥；只有前者才走 /api/v1/user/profile。
  // 用邮箱密码登录的账号，登录时把 access token 存在 key 里（magpie 的账号
  // 只有 key 一个字段），所以这里也要认它。
  const isJwt = (t) => t.split(".").length === 3
  const access = String(cred.access ?? "").trim() || (isJwt(key) ? key : "")

  if (key && !isJwt(key)) {
    const r = await requestJson(site, "/v1/usage", { headers: bearer(key), fetchImpl })
    if (r.error) return { error: `${label} ${r.error}` }
    if (r.status === 401 || r.status === 403) {
      return { error: `${label} 不认这个 API 密钥（HTTP ${r.status}）：sub2api 要用站点里建的 sk-… 密钥`, rejected: true }
    }
    if (r.status === 404) return { unrecognized: true }
    if (!r.ok) return { error: `${label} 读额度失败：${messageOf(r.body) || `HTTP ${r.status}`}` }
    const u = asRecord(r.body)
    // 200 但答的是别的东西（比如“旧转发链路已关闭”的空信封）：换一家读
    if (!u || !SUB2API_FIELDS.some((k) => k in u)) return { unrecognized: true }
    return cardOfUsage(u)
  }

  if (!access) return { error: `${label} 的账号里没有可用的凭据，请移除后重新添加` }

  // 登录令牌：快到期就续一次，续期结果写回账号（下次不用再续）
  let current = { key, access, refresh: String(cred.refresh ?? "").trim(), expires: Number(cred.expires) || 0, site }
  let renewed = false
  if (current.refresh) {
    try {
      const out = await refreshSub2ApiAuth(current, { fetchImpl, save })
      current = out.auth
      renewed = out.renewed
    } catch (e) {
      if (e?.kind === "auth") {
        return { error: `${label} 的登录态失效了，请重新添加这个账号`, signIn: "expired" }
      }
      // 续期本身失败（限流/网络）时令牌可能还能用，继续读一次
    }
  }

  const r = await requestJson(site, "/api/v1/user/profile", { headers: bearer(current.access), fetchImpl })
  if (r.error) return { error: `${label} ${r.error}` }
  if (r.status === 401 || r.status === 403) {
    return { error: `${label} 的登录态失效了，请重新添加这个账号`, signIn: "expired", rejected: true }
  }
  const d = asRecord(unwrapData(r.body)) ?? {}
  const left = num(d.balance) ?? num(d.remaining) ?? num(asRecord(d.user)?.balance)
  if (!r.ok || !d) return { error: `${label} 读额度失败：${messageOf(r.body) || `HTTP ${r.status}`}` }
  if (left === undefined) return { error: `${label} 的资料里没有余额字段（站点没开放）` }
  return { balance: money(Math.max(0, left)), ...(renewed ? { signIn: "renewed" } : {}) }
}
