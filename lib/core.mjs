// 签到管家的公共部分：HTTP、响应解包、错误分类、状态文件。
//
// 只发往用户自己配置的那些站点（magpie 的 providers.json / 账号里记的
// 地址），不带任何遥测；日志里不写密钥、不写完整响应体。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** 一次请求的超时：签到不该把插件的 55 秒额度吃完。 */
export const REQUEST_TIMEOUT = 12_000

// ---- 站点地址 ---------------------------------------------------------------

/** 去掉末尾斜杠和 /v1、/v1beta 之类的 API 后缀，留下站点根。 */
export function siteRootOf(url) {
  let u = String(url ?? "").trim()
  if (!u) return ""
  try {
    const parsed = new URL(u)
    let p = parsed.pathname.replace(/\/+$/, "")
    p = p.replace(/\/v1beta$/, "").replace(/\/v1$/, "")
    // 有的配置把 API 写在 /codex、/openai 这样的子路径上，站点 API 不在那里
    if (/^\/(api|v\d+)$/.test(p)) p = ""
    parsed.pathname = p
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return ""
  }
}

/** 一个站点对应的展示地址（给人看、给 usage 的 error 用）。 */
export function displayUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "")
}

/** 站点的主机名，用来在提示里称呼它（"example.com"）。 */
export function siteLabel(url) {
  try {
    return new URL(siteRootOf(url) || url).host
  } catch {
    return displayUrl(url)
  }
}

/** 站点在 state.json 里的键：主机 + 路径，大小写不敏感。 */
export function siteKeyOf(url) {
  const root = siteRootOf(url)
  if (!root) return ""
  try {
    const u = new URL(root)
    return (u.host + u.pathname.replace(/\/+$/, "")).toLowerCase()
  } catch {
    return ""
  }
}

/** 稳定的小哈希，用来给批量导入的账号起 key。 */
export function shortHash(text) {
  let h = 2166136261
  const s = String(text ?? "")
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

// ---- HTTP -------------------------------------------------------------------

/**
 * 一次 JSON 请求。返回 {ok, status, body, text, headers, error}：
 * 网络失败时 ok=false、status=0、error 是简短原因，绝不抛。
 */
export async function requestJson(origin, endpoint, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeout = REQUEST_TIMEOUT,
    redirect = "follow",
    fetchImpl = globalThis.fetch,
  } = options
  const url = origin.replace(/\/+$/, "") + endpoint
  // 头部只能放 ASCII：令牌里混进中文之类的字符时，fetch 会抛一句难懂的英文，
  // 这里提前说清楚是凭据本身有问题。
  const bad = Object.entries(headers).find(([, v]) => typeof v === "string" && !/^[\x20-\x7e]*$/.test(v))
  if (bad) {
    return {
      ok: false,
      status: 0,
      url,
      error: `${bad[0]} 里有不能用在 HTTP 头里的字符（凭据要复制站点给的原文，别带上多余的字）`,
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const isJsonBody = body !== undefined && typeof body !== "string"
  try {
    const res = await fetchImpl(url, {
      method,
      redirect,
      // 登录/刷新要靠 Set-Cookie 拿刷新令牌，所以手动跟重定向
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      body: parsed,
      headers: res.headers,
      url: res.url,
    }
  } catch (e) {
    const why = e?.name === "AbortError" ? `等了 ${Math.round(timeout / 1000)} 秒没有回应` : networkWhy(e)
    return { ok: false, status: 0, text: "", body: undefined, headers: new Headers(), error: why }
  } finally {
    clearTimeout(timer)
  }
}

/** 把 fetch 抛出的网络错误翻成一句人话。 */
export function networkWhy(e) {
  const code = e?.cause?.code ?? e?.code ?? ""
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "域名解析不了（DNS 失败）"
    case "ECONNREFUSED":
      return "连接被拒绝"
    case "ECONNRESET":
      return "连接被对方重置"
    case "ETIMEDOUT":
      return "连接超时"
    case "CERT_HAS_EXPIRED":
      return "站点证书过期"
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "站点证书不受信任"
    default:
      return `${e?.cause?.message ?? e?.message ?? "网络错误"}`.slice(0, 120)
  }
}

// ---- 响应解包 ---------------------------------------------------------------

/** 插件自己的错误：code 决定最终映射成哪个签到 outcome。 */
export class SiteError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = "SiteError"
    Object.assign(this, extra)
  }
}

export const asRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined

/** 常见信封 {code,data} / {success,data} 里的 data。 */
export function unwrapData(body) {
  const b = asRecord(body)
  if (!b) return undefined
  const d = asRecord(b.data)
  if (d) return d
  return b
}

/** 取一个可能是数字也可能是数字字符串的金额。 */
export function toAmount(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return undefined
}

/** 按顺序取第一个能读成金额的值。 */
export function pickAmount(...values) {
  for (const v of values) {
    const n = toAmount(v)
    if (n !== undefined) return n
  }
  return undefined
}

/** 常见信封里的 message/msg/error 文案。 */
export function messageOf(body) {
  const b = asRecord(body)
  if (!b) return ""
  if (typeof b.message === "string") return b.message
  if (typeof b.msg === "string") return b.msg
  if (typeof b.error === "string") return b.error
  const e = asRecord(b.error)
  if (e && typeof e.message === "string") return e.message
  return ""
}

/** sub2api 的错误 reason 码（DAILY_CHECKIN_DISABLED 之类）。 */
export function reasonOfBody(body) {
  const b = asRecord(body) ?? {}
  const d = asRecord(b.data) ?? {}
  const e = asRecord(b.error) ?? {}
  for (const v of [b.reason, d.reason, e.reason, b.error_code, d.error_code]) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/** 请求的简短描述，用于失败提示。 */
export function httpSummary(r) {
  if (!r) return "没有回应"
  if (r.error) return r.error
  const detail = messageOf(r.body)
  const text = detail || String(r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
  return `HTTP ${r.status}${text ? `：${text}` : ""}`
}

/** 从 JWT 里读 claims，读不出来时 undefined。 */
export function jwtClaims(token) {
  const raw = String(token ?? "").trim().replace(/^Bearer\s+/i, "")
  const parts = raw.split(".")
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    const v = JSON.parse(json)
    return asRecord(v)
  } catch {
    return undefined
  }
}

/** JWT 的过期时间（毫秒），没有 exp 时 0。 */
export function jwtExpiryMs(token) {
  const exp = Number(jwtClaims(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

/** 登录响应里 tokens 的过期时间：expires_in 秒优先，其次 JWT 的 exp。 */
export function expiryOf(expiresIn, access) {
  const n = Number(expiresIn)
  if (Number.isFinite(n) && n > 0) {
    // 有的站点给毫秒，有的给秒
    return Date.now() + (n > 1e12 ? n : n * 1000)
  }
  return jwtExpiryMs(access)
}

/** new-api / sub2api 的 business code：0 或 200 算成功。 */
export function businessCode(body) {
  const b = asRecord(body)
  if (!b) return undefined
  for (const k of ["code", "status"]) {
    const v = b[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

// ---- 文案分类 ---------------------------------------------------------------

const ALREADY = [
  "已经签到",
  "已签到",
  "今日已签",
  "今天已经签到",
  "already checked in",
  "already checked",
  "already_checked",
  "already signed in",
  "CHECKIN_ALREADY_DONE",
  "CHECKIN_ALREADY_COMPLETED",
  "DAILY_CHECKIN_ALREADY_DONE",
]

const DISABLED = [
  "未开启签到",
  "签到未开启",
  "签到已关闭",
  "签到功能未开启",
  "签到功能已关闭",
  "签到功能已停用",
  "暂未开放签到",
  "未开放签到",
  "签到已停用",
  "check-in feature is not enabled",
  "checkin is disabled",
  "check-in is disabled",
  "checkin disabled",
  "check-in disabled",
  "checkin is not enabled",
  "check-in unavailable",
  "checkin unavailable",
  "DAILY_CHECKIN_DISABLED",
  "admin_disabled",
]

const CAPTCHA = [
  "turnstile",
  "tencent_captcha",
  "tencent captcha",
  "captcha",
  "人机验证",
  "验证码",
  "cf-chl",
  "challenge",
]

const AUTH = [
  "unauthorized",
  "unauthenticated",
  "not logged in",
  "login required",
  "invalid access token",
  "access token 无效",
  "access token 失效",
  "access token 已过期",
  "未登录",
  "用户不存在",
  "请先登录",
  "auth_session_required",
  "auth_unauthorized",
]

const PERMISSION = [
  "拍卖",
  "权限不足",
  "无权限",
  "没有权限",
  "无权进行此操作",
  "insufficient privileges",
  "permission denied",
  "forbidden",
  "role_forbidden",
  "DAILY_CHECKIN_ROLE_FORBIDDEN",
]

const RATE = ["请求过于频繁", "频率", "限流", "rate limit", "too many requests", "throttle"]

const matchAny = (haystack, list) => list.some((s) => haystack.includes(s))
const lower = (s) => String(s ?? "").toLowerCase()

export const isAlreadyCheckedText = (s) => matchAny(lower(s), ALREADY.map(lower))
export const isDisabledText = (s) => matchAny(lower(s), DISABLED.map(lower))
export const isCaptchaText = (s) => matchAny(lower(s), CAPTCHA)
export const isAuthText = (s) => matchAny(lower(s), AUTH.map(lower))
export const isPermissionText = (s) => matchAny(lower(s), PERMISSION.map(lower))
export const isRateLimitText = (s) => matchAny(lower(s), RATE.map(lower))

/** 一句文案的归类，用于把失败说得更具体。 */
export const REASONS = {
  disabled: "disabled",
  captcha: "captcha",
  auth: "auth",
  permission: "permission",
  rate: "rate",
  other: "other",
}

export function reasonOf(message) {
  if (isDisabledText(message)) return REASONS.disabled
  if (isCaptchaText(message)) return REASONS.captcha
  if (isAuthText(message)) return REASONS.auth
  if (isPermissionText(message)) return REASONS.permission
  if (isRateLimitText(message)) return REASONS.rate
  return REASONS.other
}

// ---- 状态文件 ---------------------------------------------------------------

export function stateDir(directory) {
  const base = directory || path.join(os.homedir(), ".config", "magpie")
  const dir = path.join(base, "auto-checkin")
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
  return dir
}

export function statePath(directory) {
  return path.join(stateDir(directory), "state.json")
}

export function readState(directory) {
  for (const p of [statePath(directory), statePath(directory) + ".bak"]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"))
      const r = asRecord(v)
      if (r) return r
    } catch {}
  }
  return { version: 1, accounts: {} }
}

export function writeState(directory, state) {
  const p = statePath(directory)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    try {
      fs.copyFileSync(p, p + ".bak")
    } catch {}
    fs.renameSync(tmp, p)
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }
