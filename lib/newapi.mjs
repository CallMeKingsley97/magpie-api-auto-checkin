// new-api（以及 Veloera、Rix API 这些同族站点）的额度读取。
//
// 只用两把钥匙能打开的公开接口：
//  - GET /api/status       公开，给出站点按什么货币显示额度（quota_display_type）、
//                          多少 quota 算 1 美元（quota_per_unit）和汇率；
//  - GET /api/usage/token/ 用站点里建的那把令牌（sk-…）读自己这一把的额度：
//                          total_granted / total_used / total_available /
//                          unlimited_quota / expires_at。
// new-api 的 /api/user/self 要的是登录态，令牌一律 401；所以额度只能从上面这
// 两处来，读不到就如实说读不到。

import { asRecord, messageOf, requestJson, siteLabel, unwrapData } from "./core.mjs"

const PROBE_TIMEOUT = 8000

// /api/usage/token/ 的回答里必有这几个字段之一；都没有就说明这不是 new-api
const NEW_API_FIELDS = ["total_granted", "total_available", "total_used", "unlimited_quota", "object"]


/** 数字，接受数字和数字字符串；其余一律 undefined。 */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

const positive = (v) => {
  const n = num(v)
  return n !== undefined && n > 0 ? n : undefined
}

/**
 * 额度数字：够大就不带小数，1 以下留四位——站点上的额度可能小到 0.0032，
 * 一律两位会把它显示成 0，看起来像“用完了”。
 */
export function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return ""
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4
  let s = n.toFixed(digits)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  return s === "-0" ? "0" : s
}

/** 站点按什么货币显示额度。字段缺省时按美元算（new-api 的默认）。 */
export function currencyOf(status) {
  const d = asRecord(status) ?? {}
  const declared = String(d.quota_display_type ?? "").toUpperCase()
  const type = ["USD", "CNY", "TOKENS", "CUSTOM"].includes(declared)
    ? declared
    : d.display_in_currency === false
      ? "TOKENS"
      : "USD"
  const symbol = String(d.custom_currency_symbol ?? "").trim()
  return {
    type,
    qpu: positive(d.quota_per_unit) ?? 500_000,
    usdRate: positive(d.usd_exchange_rate) ?? 1,
    // new-api 的默认占位符 ¤ 表示“没配货币”，别把它画到卡片上
    symbol: symbol && symbol !== "¤" ? symbol : "",
    customRate: positive(d.custom_currency_exchange_rate) ?? 1,
  }
}

/**
 * 原始额度（quota 单位）→ {value, unit, text}。
 * value/unit 用来给 magpie 的额度窗口画“已用 / 总额”，text 是余额那一行。
 */
export function amountOf(quota, cur) {
  const usd = quota / cur.qpu
  switch (cur.type) {
    case "TOKENS":
      return { value: quota, unit: "", text: formatNumber(quota) }
    case "CNY": {
      const v = usd * cur.usdRate
      return { value: v, unit: "CNY", text: `¥${formatNumber(v)}` }
    }
    case "CUSTOM": {
      const v = usd * cur.customRate
      return { value: v, unit: cur.symbol || "USD", text: `${cur.symbol ? `${cur.symbol} ` : ""}${formatNumber(v)}` }
    }
    default:
      return { value: usd, unit: "USD", text: `$${formatNumber(usd)}` }
  }
}

/** 一个额度窗口：magpie 用 used（百分比）画条，用 amount/limit/unit 写“已用 / 总额”。 */
function quotaWindow(name, used, limit, cur) {
  const u = amountOf(used, cur)
  const t = amountOf(limit, cur)
  return {
    name,
    used: limit > 0 ? (used / limit) * 100 : 0,
    // magpie 只按两位小数写 amount / limit：额度小到 0.0032 会被写成 0.00，
    // 看着像用完了。这种时候只给 display，让 magpie 原样用我们写好的文字。
    ...(limit >= 0.01 ? { amount: u.value, limit: t.value, unit: u.unit } : {}),
    display: `${u.text} / ${t.text}`,
  }
}

/**
 * 读一把 new-api 令牌的额度。返回 {
 *   account?（令牌名字）, balance?, windows?, until?, error?, signIn?
 * }，交给 usage.mjs 拼成卡片。
 */
export async function readNewApi(site, token, { fetchImpl } = {}) {
  const label = siteLabel(site)
  const key = String(token ?? "").trim()
  if (!key) return { error: `账号里没有令牌，请移除 ${label} 后重新添加` }

  // 两个接口互不依赖，一起发
  const [status, usage] = await Promise.all([
    requestJson(site, "/api/status", { timeout: PROBE_TIMEOUT, fetchImpl }),
    requestJson(site, "/api/usage/token/", { headers: { Authorization: `Bearer ${key}` }, fetchImpl }),
  ])

  if (usage.error) return { error: `${label} ${usage.error}` }
  if (usage.status === 401 || usage.status === 403) {
    // 401 只说明“不认这个凭据”，不说明“这不是 new-api”：留给上层再试 sub2api
    return {
      error: `${label} 不认这个令牌（HTTP ${usage.status}）：new-api 要用站点「令牌」页建的 sk-… 令牌`,
      signIn: "expired",
      rejected: true,
    }
  }
  // 根本不是这个接口（404、被网关/Cloudflare 换成 HTML）：让上层换一家读法再试
  if (usage.status === 404 || usage.status === 405) return { unrecognized: true }
  // 站点自己坏了（5xx）：如实报，不假装“没认出来”
  if (!usage.ok) return { error: `${label} 读额度失败：${messageOf(usage.body) || `HTTP ${usage.status}`}` }
  const d = asRecord(unwrapData(usage.body))
  // 200 但答的是别的东西（关闭了的转发链路回 {code:0,data:null} 之类）：换一家读
  if (!d || !NEW_API_FIELDS.some((k) => k in d)) return { unrecognized: true }

  const cur = currencyOf(asRecord(unwrapData(status.body)))
  const unlimited = d.unlimited_quota === true
  const used = num(d.total_used) ?? 0
  const available = num(d.total_available) ?? 0
  const granted = num(d.total_granted) ?? 0

  // 有的站点会返回用户总额度（令牌被允许查的时候）；它比令牌自己的额度更接近
  // 用户真正关心的问题——“我账号里还剩多少”。
  const uq = asRecord(d.user_quota)
  const userAvailable = uq ? num(uq.total_available) : undefined
  const userUsed = uq ? num(uq.total_used) : undefined

  const card = {}
  if (unlimited && userAvailable !== undefined) {
    const left = Math.max(0, userAvailable)
    card.balance = amountOf(left, cur).text
    const total = Math.max(left + Math.max(0, userUsed ?? 0), left)
    if (total > 0) card.windows = [quotaWindow("额度", Math.max(0, userUsed ?? 0), total, cur)]
  } else if (unlimited) {
    // 令牌不限额，额度记在用户账上而站点不让查：不编一个数字出来
    card.balance = "无限"
  } else {
    const left = Math.max(0, available)
    card.balance = amountOf(left, cur).text
    const total = granted > 0 ? granted : used + left
    if (total > 0) card.windows = [quotaWindow("额度", used, total, cur)]
  }

  const name = String(d.name ?? "").trim()
  if (name) card.account = name
  const expires = num(d.expires_at)
  // -1 是 new-api 里“永不过期”的老写法，0 是“没有设置”
  if (expires !== undefined && expires > 0) card.until = expires * 1000
  return card
}
