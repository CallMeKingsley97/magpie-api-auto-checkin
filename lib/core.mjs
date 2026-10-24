// 额度管家的公共部分：HTTP、响应解包、限流退避、状态文件。
//
// 只发往用户自己配置的那些站点（magpie 的 providers.json / 账号里记的
// 地址），不带任何遥测；日志里不写密钥、不写完整响应体。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** 一次请求的超时：插件不该把 magpie 的一次刷新拖成几十秒。 */
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

/** 站点的主机名，用来在提示里称呼它（"example.com"）。 */
export function siteLabel(url) {
  try {
    return new URL(siteRootOf(url) || url).host
  } catch {
    return String(url ?? "").trim().replace(/\/+$/, "")
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

// ---- 限流退避 ---------------------------------------------------------------
//
// 站点回 429 时短时间内别再敲它。Usage 卡片会被 magpie 反复刷新，一次限流
// 不该变成一串重试。退避只在本进程里有效（插件重启就清空），不写盘。

const cooldowns = new Map() // 站点根 -> { until, strikes }
const COOLDOWN_BASE_MS = 60_000
const COOLDOWN_MAX_MS = 15 * 60_000

/** Retry-After 可能是秒数，也可能是 HTTP 日期。 */
function parseRetryAfter(value) {
  const s = String(value ?? "").trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const at = Date.parse(s)
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : 0
}

/** 站点回了 429：按 Retry-After 或递增的退避时间暂停对它的请求。 */
export function noteRateLimit(origin, retryAfter = 0) {
  const key = siteRootOf(origin) || String(origin ?? "").replace(/\/+$/, "")
  if (!key) return 0
  const prev = cooldowns.get(key)
  // 上一次限流已经过去一小时以上，就不算“连续被限”，从第一次的短退避重新数
  const stale = !prev || Date.now() - prev.until > 60 * 60_000
  const strikes = stale ? 1 : prev.strikes + 1
  const waitMs =
    retryAfter > 0
      ? retryAfter * 1000
      : Math.min(COOLDOWN_BASE_MS * 2 ** Math.min(strikes - 1, 4), COOLDOWN_MAX_MS)
  const until = Date.now() + Math.min(Math.max(waitMs, 1000), COOLDOWN_MAX_MS)
  cooldowns.set(key, { until, strikes })
  return until
}

/** 还在退避窗口里就返回剩余秒数；0 表示可以请求。 */
export function rateLimitSeconds(origin) {
  const key = siteRootOf(origin) || String(origin ?? "").replace(/\/+$/, "")
  if (!key) return 0
  const c = cooldowns.get(key)
  if (!c) return 0
  const left = c.until - Date.now()
  if (left <= 0) return 0
  return Math.ceil(left / 1000)
}

/** 仅供测试：清空退避记录。 */
export function resetRateLimits() {
  cooldowns.clear()
}

// ---- HTTP -------------------------------------------------------------------

/**
 * 一次 JSON 请求。返回 {ok, status, body, text, headers, error}：
 * 网络失败时 ok=false、status=0、error 是简短原因，绝不抛。
 *
 * 站点刚回过 429 的话，这里直接返回一条“限流”结果，不再碰网络——
 * 调用方会把 status=429 当成限流处理。
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
  // 这个站点刚限流过：这段时间里一次请求都不发，免得把节流刷成封锁
  const wait = rateLimitSeconds(origin)
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      url,
      text: "",
      body: undefined,
      headers: new Headers(),
      error: `站点刚才限流了，${wait} 秒内不再请求它`,
      throttled: true,
    }
  }
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
    // 429 是站点明说“别这么快再来”：记下来，后面几分钟一次都不再发
    if (res.status === 429) noteRateLimit(origin, parseRetryAfter(res.headers.get("retry-after")))
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
function networkWhy(e) {
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

/** 插件自己的错误：kind 标出是哪一类失败（auth / rate / captcha）。 */
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

/** 请求的简短描述，用于失败提示。 */
export function httpSummary(r) {
  if (!r) return "没有回应"
  if (r.error) return r.error
  const detail = messageOf(r.body)
  const text = detail || String(r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
  return `HTTP ${r.status}${text ? `：${text}` : ""}`
}

/** 从 JWT 里读 claims，读不出来时 undefined。 */
function jwtClaims(token) {
  const raw = String(token ?? "").trim().replace(/^Bearer\s+/i, "")
  const parts = raw.split(".")
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    return asRecord(JSON.parse(json))
  } catch {
    return undefined
  }
}

/** JWT 的过期时间（毫秒），没有 exp 时 0。 */
export function jwtExpiryMs(token) {
  const exp = Number(jwtClaims(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

// ---- 状态文件 ---------------------------------------------------------------

function statePath(directory) {
  const base = directory || path.join(os.homedir(), ".config", "magpie")
  return path.join(base, "quota-manager", "state.json")
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
