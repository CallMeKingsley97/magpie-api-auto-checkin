// 各站点的签到实现。
//
// 插件只做两件“懂行”的事：认站点（new-api 还是 sub2api），和按站点类型
// 去签到。认不出来就老实说“没适配”，不猜、不试探性地乱发请求。
//
// 站点地址与凭据都来自用户自己的 magpie 配置，请求只发往这些站点。

import {
  SiteError,
  asRecord,
  displayUrl,
  httpSummary,
  isAlreadyCheckedText,
  isAuthText,
  isCaptchaText,
  isDisabledText,
  isPermissionText,
  isRateLimitText,
  jwtExpiryMs,
  messageOf,
  pickAmount,
  reasonOfBody,
  requestJson,
  siteLabel,
  sleep,
  toAmount,
  unwrapData,
} from "./core.mjs"

/** 签到用的时区：跟着 magpie 的日界走（北京时间）。 */
export const TZ = "Asia/Shanghai"

// 探测用的短超时：一个不存在的端点不该拖太久
const PROBE_TIMEOUT = 8000
const CHECKIN_TIMEOUT = 15000

// ---- 小工具 -----------------------------------------------------------------

const bearer = (token) => (token ? { Authorization: `Bearer ${String(token).trim()}` } : {})

/** 200 且（有 code/status 时）code 是 0/200 才算业务成功。 */
function envelopeOk(r) {
  if (!r?.ok) return false
  const b = asRecord(r.body)
  if (!b) return true
  for (const k of ["code", "status"]) {
    const v = b[k]
    if (typeof v === "number" && Number.isFinite(v) && v !== 0 && v !== 200) return false
  }
  // FreeAPI / Clawhud 这类分支在传输级失败时把 code 换成字符串
  // （`UNAUTHORIZED` 之类），HTTP 却仍是 200。字符串只对 code 判：
  // 顶层的 status 有时是别的东西。
  if (typeof b.code === "string" && b.code.trim() && b.code.trim() !== "0" && b.code.trim() !== "200") {
    return false
  }
  if (b.success === false) return false
  return true
}

/** 一次不带参数的探测；网络错误原样返回（调用方决定是“站点不可达”还是“没这个接口”）。 */
async function probeJson(site, path, { token, method = "GET", body, timeout = PROBE_TIMEOUT, fetchImpl } = {}) {
  return requestJson(site, path, {
    method,
    headers: bearer(token),
    body,
    timeout,
    fetchImpl,
  })
}

/** 把一次失败的回答说成人话，并给出归类。 */
function failureText(r, { what = "请求" } = {}) {
  const message = messageOf(r?.body) || String(r?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
  const reason = reasonOfBody(r?.body)
  const base = r?.error ? r.error : `HTTP ${r?.status ?? "?"}`
  const text = [base, reason, message].filter(Boolean).join(" · ")
  return `${what}失败：${text}`
}

/** 一句站点侧文案的分类（用于把“管理员关了”和“没权限”分开）。 */
function classifyText(text) {
  if (isDisabledText(text)) return "disabled"
  if (isCaptchaText(text)) return "captcha"
  if (isAlreadyCheckedText(text)) return "done"
  if (isPermissionText(text)) return "ineligible"
  if (isAuthText(text)) return "auth"
  if (isRateLimitText(text)) return "rate"
  return "other"
}

/** 已签到 → done（尽量带上今天拿到的奖励）。 */
const done = (message = "今日已签到") => ({ outcome: "done", message })

/** 管理员没开签到 → inactive。 */
const adminOff = (site) => ({
  outcome: "inactive",
  message: `${siteLabel(site)} 没有开启签到（站点管理员把签到功能关掉了）`,
})

/** 这个站点的这类接口不存在 → 插件没适配。 */
const notAdapted = (site, why = "") => ({
  outcome: "inactive",
  message: `签到管家暂时没适配 ${siteLabel(site)} 这个站点的签到${why ? `（${why}）` : ""}`,
})

// ---- new-api ----------------------------------------------------------------

/**
 * 站点公开状态里的签到开关。同一家族有三套字段，按可靠程度取第一个出现的：
 *  - `checkin_enabled`：new-api 官方字段；
 *  - `check_in_enabled`：Veloera（签到接口也换成了 /api/user/check_in）；
 *  - `enable_checkin`：Rix API 等分支（接口仍是官方那套）。
 *
 * 返回 {variant, enabled, data}；一个都没出现时 variant 为空。
 */
function readSiteFlag(status) {
  const data = asRecord(unwrapData(status?.body)) ?? {}
  if ("checkin_enabled" in data) {
    return { variant: "new-api", enabled: data.checkin_enabled === true, data }
  }
  if ("check_in_enabled" in data) {
    return { variant: "veloera", enabled: data.check_in_enabled === true, data }
  }
  if ("enable_checkin" in data) {
    return { variant: "new-api", enabled: data.enable_checkin === true, data }
  }
  return { data }
}

/**
 * 这个站点是不是 new-api（或它的分支：Veloera、voapi 等）。
 *
 * 判据从硬到软：
 *  1. GET /api/status 里有 checkin_enabled / check_in_enabled / enable_checkin；
 *  2. GET /api/user/checkin 用访问令牌拿到 {success,data:{enabled,…}} —— 带鉴权的确认；
 *  3. GET /api/user/checkin 不带令牌回 401 且响应像 new-api 的信封。
 * 返回 {kind, variant, confidence, checkinEnabled?, version?, detail} 或 undefined。
 */
export async function detectNewApi(site, { token, fetchImpl } = {}) {
  const status = await probeJson(site, "/api/status", { fetchImpl })
  if (status.ok) {
    const flag = readSiteFlag(status)
    if (flag.variant) {
      const d = flag.data
      return {
        kind: "new-api",
        variant: flag.variant,
        confidence: "high",
        checkinEnabled: flag.enabled,
        version: typeof d?.version === "string" ? d.version : "",
        siteName: typeof d?.system_name === "string" ? d.system_name : "",
        detail:
          flag.variant === "veloera"
            ? "GET /api/status 里有 check_in_enabled（Veloera）"
            : "GET /api/status 里有签到开关",
      }
    }
  }
  // 有的站点把 /api/status 换掉了，用签到接口本身再确认一次
  const probe = await probeJson(site, `/api/user/checkin?month=${monthOf()}`, { token, fetchImpl })
  const data = asRecord(unwrapData(probe.body))
  if (data && ("enabled" in data || "stats" in data || "checked_in" in data)) {
    return {
      kind: "new-api",
      variant: "new-api",
      confidence: "high",
      checkinEnabled: data.enabled !== false,
      detail: "GET /api/user/checkin 返回了签到状态",
    }
  }
  // Veloera 的分支站没有 /api/status 里的开关时，读它的签到状态接口
  const veloera = await probeJson(site, "/api/user/check_in_status", { token, fetchImpl })
  const vdata = asRecord(unwrapData(veloera.body))
  if (vdata && typeof vdata.can_check_in === "boolean") {
    return {
      kind: "new-api",
      variant: "veloera",
      confidence: "high",
      detail: "GET /api/user/check_in_status 答了 can_check_in",
    }
  }
  if (probe.status === 401 && asRecord(probe.body)?.success === false) {
    return {
      kind: "new-api",
      variant: "new-api",
      confidence: "medium",
      detail: "GET /api/user/checkin 要求登录",
    }
  }
  // 有的站点（或它前面的网关）把「未登录」「令牌无效」也当成 200 回，
  // 但 body 是 new-api 的信封：success=false + 英文文案。没有其它站点
  // 长这样，可以据此认下来。认不出来时调用方会带真实令牌再试一次。
  if (probe.status === 200 && asRecord(probe.body)?.success === false) {
    return {
      kind: "new-api",
      variant: "new-api",
      confidence: "medium",
      detail: "GET /api/user/checkin 回了 new-api 风格的错误信封",
    }
  }
  // 没带令牌又明确说“签到没开”
  if (probe.ok && isDisabledText(messageOf(probe.body))) {
    return {
      kind: "new-api",
      variant: "new-api",
      confidence: "medium",
      checkinEnabled: false,
      detail: "签到接口说未开启",
    }
  }
  return undefined
}

function monthOf(now = new Date()) {
  // 北京时间当月，YYYY-MM
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const year = parts.find((p) => p.type === "year")?.value ?? "1970"
  const month = parts.find((p) => p.type === "month")?.value ?? "01"
  return `${year}-${month}`
}

/**
 * new-api 的签到状态（需要访问令牌）。
 * 返回 {enabled, today, todayCredit, totalCheckins, totalQuota, checkinCount, records}。
 *
 * “今天签没签”只信结构化字段：`stats.checked_in_today`（官方）、
 * `data.checked_in`（WONG 公益站这类分支）、或当月记录里今天那一条。
 * 不用失败文案的措辞来猜——那是各家自己翻的，不可靠。
 */
export async function newApiStatus(site, token, { fetchImpl, variant = "new-api" } = {}) {
  if (variant === "veloera") return veloeraStatus(site, token, { fetchImpl })

  const r = await probeJson(site, `/api/user/checkin?month=${monthOf()}`, { token, fetchImpl })
  if (r.error) throw new SiteError(`读签到状态失败：${r.error}（${siteLabel(site)} 连不上）`)
  if (r.status === 401 || r.status === 403) {
    throw new SiteError(
      `读签到状态失败：站点不认这个访问令牌（HTTP ${r.status}${messageOf(r.body) ? ` · ${messageOf(r.body)}` : ""}）`,
      { kind: "auth" },
    )
  }
  // 读不出 `enabled` 时的默认值：签到开着，今天没签；状态接口里没有余额，
  // 余额另外读（见 newApiBalance），读不到也不该让签到被当成失败。
  const status = {
    enabled: true,
    site,
    today: false,
    todayCredit: undefined,
    checkinCount: undefined,
    totalCheckins: undefined,
    totalQuota: undefined,
    minQuota: undefined,
    maxQuota: undefined,
    authError: false,
  }
  if (!envelopeOk(r)) {
    const text = messageOf(r.body) || `HTTP ${r.status}`
    // 管理员关掉时，new-api 的签到接口就是这么回的
    if (isDisabledText(text)) {
      status.enabled = false
      return status
    }
    // 有的站点把签到状态藏在登录后：令牌不作数就只标“要重新登录”，
    // 让签名流程接管；其他业务错误原样抛出（签到本身也读不了）
    if (isAuthText(text)) {
      status.authError = true
      status.authMessage = text
      return status
    }
    throw new SiteError(`读签到状态失败：${text}`)
  }
  const data = asRecord(unwrapData(r.body)) ?? {}
  const stats = asRecord(data.stats) ?? {}
  const records = Array.isArray(stats.records) ? stats.records : []
  const today = beijingDay()
  const todayRecord = records.find((x) => String(asRecord(x)?.checkin_date ?? "") === today)
  Object.assign(status, {
    enabled: data.enabled !== false,
    today: stats.checked_in_today === true || data.checked_in === true || !!todayRecord,
    todayCredit: toAmount(todayRecord?.quota_awarded) ?? toAmount(data.quota),
    checkinCount: toAmount(stats.checkin_count),
    totalCheckins: toAmount(stats.total_checkins),
    totalQuota: toAmount(stats.total_quota),
    minQuota: toAmount(data.min_quota),
    maxQuota: toAmount(data.max_quota),
  })
  return status
}

/**
 * new-api 的余额：GET /api/user/self 里的 quota。只有读用量（usage 卡片）
 * 会调它；签到流程不靠余额，读失败也不影响签到。
 *
 * new-api 的 quota 单位是站点自己定的“额度”，没有可靠的换算，所以只报数字，
 * 不硬编成美元——那会让用户以为余额是钱。
 */
async function newApiBalance(site, token, { fetchImpl } = {}) {
  const r = await probeJson(site, "/api/user/self", { token, fetchImpl })
  if (r.error) return { error: r.error }
  if (!envelopeOk(r)) {
    const text = messageOf(r.body) || `HTTP ${r.status}`
    // 401/403 或报文说“未登录/令牌无效”：是登录态的问题，不是余额读不出来
    if (r.status === 401 || r.status === 403 || isAuthText(text)) {
      const why = r.status === 200 ? text : `HTTP ${r.status}${text && text !== `HTTP ${r.status}` ? ` · ${text}` : ""}`
      return { error: `站点不认这个访问令牌（${why}）`, auth: true }
    }
    return { error: text }
  }
  const data = asRecord(unwrapData(r.body)) ?? {}
  const user = asRecord(data.user) ?? data
  const balance = pickAmount(user?.quota, user?.balance, user?.remain_quota, data.quota, data.balance)
  const used = pickAmount(user?.used_quota, user?.used, data.used_quota)
  return {
    balance,
    used,
    user: String(user?.username ?? user?.display_name ?? user?.email ?? "").trim(),
    // new-api 的 quota 没有单位字段，按额度算
    unit: balance !== undefined ? "额度" : "",
  }
}

/**
 * Veloera 的签到状态：开关在公开的 /api/status（check_in_enabled），
 * 今天签没签在 /api/user/check_in_status（can_check_in）。
 * 两处都要读——只有 can_check_in 证明不了站点开没开签到。
 */
async function veloeraStatus(site, token, { fetchImpl } = {}) {
  const status = await probeJson(site, "/api/status", { fetchImpl })
  const flag = readSiteFlag(status)
  const enabled = typeof flag.enabled === "boolean" ? flag.enabled : undefined
  if (enabled === false) return { enabled: false, site }

  const r = await probeJson(site, "/api/user/check_in_status", { token, fetchImpl })
  if (r.error) throw new SiteError(`读签到状态失败：${r.error}（${siteLabel(site)} 连不上）`)
  if (r.status === 401 || r.status === 403) {
    throw new SiteError(
      `读签到状态失败：站点不认这个访问令牌（HTTP ${r.status}${messageOf(r.body) ? ` · ${messageOf(r.body)}` : ""}）`,
      { kind: "auth" },
    )
  }
  const data = asRecord(unwrapData(r.body)) ?? {}
  if (data.can_check_in === true) return { enabled: true, site, today: false }
  if (data.can_check_in === false) return { enabled: true, site, today: true }
  // 读不出今天的状态：开关开着就当还没签，让签到接口自己回答
  return { enabled: enabled !== false, site, today: false }
}

function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/**
 * new-api 签到。用访问令牌（永久有效），不需要浏览器会话。
 * variant 是 detectNewApi 认出来的分支：Veloera 用 /api/user/check_in。
 * 返回 {outcome, credit?, message}。
 */
export async function checkinNewApi(site, token, { fetchImpl, variant = "new-api" } = {}) {
  const label = siteLabel(site)
  if (!token) {
    return { outcome: "failed", message: "没有访问令牌，签到需要先在站点里建一个" }
  }
  const endpoint = variant === "veloera" ? "/api/user/check_in" : "/api/user/checkin"

  // 先读状态：能一次分清“管理员没开”“今天已签”“可以直接签”
  let status
  try {
    status = await newApiStatus(site, token, { fetchImpl, variant })
  } catch (e) {
    if (e?.kind === "auth") {
      return {
        outcome: "failed",
        message:
          `${label} 不认这个访问令牌了：${e.message}。` +
          `去站点的「设置 → 访问令牌」重新生成一个（如果站点的旧式令牌退役了，请建带 wallet 读写的新令牌）`,
      }
    }
    return { outcome: "failed", message: `${label}：${e?.message ?? e}` }
  }
  if (!status.enabled) return adminOff(site)
  // 状态接口说令牌不作数：签到还没试，按登录失效报。能重新登录的
  // sub2api 会自动续期；new-api 只能请用户去站点重新生成令牌。
  if (status.authError) {
    return {
      outcome: "failed",
      message:
        `${label} 不认这个访问令牌了${status.authMessage ? `（${status.authMessage}）` : ""}。` +
        `去站点的「设置 → 访问令牌」重新生成一个（如果站点的旧式令牌退役了，请建带 wallet 读写的新令牌）`,
    }
  }
  if (status.today) {
    return {
      outcome: "done",
      credit: status.todayCredit,
      message: `今日已签到${status.todayCredit ? `，今天拿到 ${status.todayCredit} 额度` : ""}`,
    }
  }

  const r = await requestJson(site, endpoint, {
    method: "POST",
    headers: bearer(token),
    body: {},
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (r.error) return { outcome: "failed", message: `${label} 连不上：${r.error}` }

  const data = asRecord(unwrapData(r.body)) ?? {}
  if (envelopeOk(r)) {
    const credit = toAmount(data.quota_awarded) ?? toAmount(data.quota) ?? toAmount(data.reward_amount)
    return {
      outcome: "claimed",
      credit,
      message: `签到成功${credit ? `，拿到 ${credit} 额度` : ""}${
        data.checkin_date ? `（${data.checkin_date}）` : ""
      }`,
    }
  }

  const text = messageOf(r.body) || `HTTP ${r.status}`
  const kind = classifyText(text)
  if (kind === "done") {
    return { outcome: "done", credit: toAmount(data.quota_awarded) ?? toAmount(data.quota), message: "今日已签到" }
  }
  if (kind === "disabled") return adminOff(site)
  if (kind === "captcha") {
    return {
      outcome: "captcha",
      message: `${label} 的签到要过人机验证（Turnstile），插件不去破解验证码，请到站点网页上手动签到一次`,
    }
  }
  if (kind === "auth") {
    return {
      outcome: "failed",
      message: `${label} 说没登录或令牌无效：${text}。去站点重新生成访问令牌再填一次`,
    }
  }
  if (kind === "ineligible") return { outcome: "ineligible", message: `站点不允许这个账号签到：${text}` }
  if (kind === "rate") return { outcome: "failed", message: `被站点限流了：${text}（稍后会自动重试）` }

  // 失败文案是各站点自己翻的，不可靠。再读一次状态：如果其实已经签上了
  // （比如请求到了、响应丢了），就如实报“已签到”，而不是丢一个失败的假象。
  try {
    const after = await newApiStatus(site, token, { fetchImpl, variant })
    // 回读说令牌不作数：POST 那句“失败”就不可信了，别按“已签到”报
    if (!after.authError && after.today) {
      return {
        outcome: "done",
        credit: after.todayCredit,
        message: `今日已签到${after.todayCredit ? `，今天拿到 ${after.todayCredit} 额度` : ""}`,
      }
    }
    if (!after.authError && after.enabled === false) return adminOff(site)
  } catch {}
  return { outcome: "failed", message: failureText(r, { what: "签到" }) }
}

// ---- sub2api ----------------------------------------------------------------

/** 登录 sub2api 站点，返回可存进 magpie 的凭据。 */
export async function loginSub2Api(site, { email, password }, { fetchImpl } = {}) {
  const label = siteLabel(site)
  const r = await requestJson(site, "/api/v1/auth/login", {
    method: "POST",
    body: { email: String(email ?? "").trim(), password: String(password ?? "") },
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (r.error) throw new SiteError(`${label} 连不上：${r.error}`)
  const data = asRecord(unwrapData(r.body)) ?? {}
  const access = String(data.access_token ?? data.accessToken ?? "").trim()
  const refresh = String(data.refresh_token ?? data.refreshToken ?? "").trim()
  if (!envelopeOk(r) || !access) {
    const text = messageOf(r.body) || `HTTP ${r.status}`
    const kind = classifyText(text)
    if (kind === "captcha") {
      throw new SiteError(`${label} 的登录要过人机验证（Turnstile），插件不破解验证码，请改用「sub2api 手动导入令牌」方式`, {
        kind: "captcha",
      })
    }
    throw new SiteError(`${label} 登录失败：${text}`, { kind })
  }
  const user = asRecord(data.user) ?? {}
  return {
    access,
    refresh,
    // 优先信 JWT 自己的 exp；令牌不是 JWT 时用站点给的 expires_in
    expires: jwtExpiryMs(access) || Date.now() + (toAmount(data.expires_in) ?? 0) * 1000,
    accountId: String(user.email ?? user.username ?? email ?? "").trim() || label,
    uid: String(user.id ?? "").trim(),
    site,
  }
}

/** 令牌快到期时用 refresh_token 换新的；返回 {auth, renewed}。 */
export async function refreshSub2ApiAuth(auth, { fetchImpl, save } = {}) {
  const refresh = String(auth?.refresh ?? "").trim()
  if (!refresh) return { auth, renewed: false }
  const expires = Number(auth?.expires) || jwtExpiryMs(auth?.access)
  if (expires && Date.now() < expires - 5 * 60 * 1000) return { auth, renewed: false }

  const site = auth.site
  const r = await requestJson(site, "/api/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: refresh },
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (r.error) throw new SiteError(`${siteLabel(site)} 连不上（刷新登录态失败）：${r.error}`)
  const data = asRecord(unwrapData(r.body)) ?? {}
  const access = String(data.access_token ?? data.accessToken ?? "").trim()
  if (!envelopeOk(r) || !access) {
    throw new SiteError(
      `${siteLabel(site)} 的登录态失效了，需要重新登录：${messageOf(r.body) || `HTTP ${r.status}`}`,
      { kind: "auth" },
    )
  }
  const next = {
    ...auth,
    access,
    refresh: String(data.refresh_token ?? data.refreshToken ?? refresh).trim(),
    expires: jwtExpiryMs(access) || Date.now() + (toAmount(data.expires_in) ?? 0) * 1000,
  }
  try {
    await save?.(next)
  } catch {}
  return { auth: next, renewed: true }
}

// ---- sub2api 各实现 ---------------------------------------------------------
//
// 都是 sub2api 的分支站，登录方式一样，但签到接口各有各的路径和字段。
// 每个实现声明自己的状态接口、签到接口、以及怎么从 data 里认领自己的
// 报文（match）。match 必须够严：`/api/v1/user/checkin/status` 这条路径就
// 被两家共用，字段名只差一个 `today_checked_in` / `checked_in_today`，
// 光看 `enabled` 会把 A 家的签到发到 B 家的接口上。

const tzQuery = () => `timezone=${encodeURIComponent(TZ)}`

/** 一份 data 里有没有这些字段，且类型都对。 */
const hasBooleans = (d, keys) => keys.every((k) => typeof d[k] === "boolean")
const hasNumber = (d, k) => typeof d[k] === "number" && Number.isFinite(d[k])

/**
 * 重复签到时各站点回的专业错误码。比匹配文案可靠：这些码是协议的一部分，
 * 而且 `reason` 字段不会因为站点换了语言就变。
 */
const DUPLICATE_REASONS = {
  "sub2api-pro": ["DAILY_CHECKIN_ALREADY_DONE"],
  toolcode: ["CHECKIN_ALREADY_COMPLETED"],
  clawhud: ["CHECKIN_ALREADY_DONE"],
  denxio: ["TBE_SPONSOR_CHECKIN_ALREADY_DONE"],
  "ai-router": ["DAILY_CHECKIN_CLAIMED"],
}

const DISABLED_REASONS = {
  "sub2api-pro": ["DAILY_CHECKIN_DISABLED"],
  denxio: ["TBE_SPONSOR_CHECKIN_DISABLED"],
}

const FORBIDDEN_REASONS = {
  "sub2api-pro": ["DAILY_CHECKIN_ROLE_FORBIDDEN"],
  "ai-router": ["DAILY_CHECKIN_RESTRICTED"],
  // Denxio：没有可赞助的会话，是账号资格问题；SESSION_INVALID/PENDING 属于
  // 这次挑战本身的状态，按普通失败报，下次重试还能好。
  denxio: ["TBE_SPONSOR_CHECKIN_NO_SPONSOR"],
}

/**
 * 一个实现：
 *  - match(data)：这份状态报文是不是它的（严格指纹）；
 *  - enabled(data)：站点有没有开签到（管理员开关）；
 *  - done(data)：今天签没签；
 *  - ineligible(data)：账号有没有资格（门槛没到、等级不够）；
 *  - can(data)：现在能不能签（和 enabled 分开——站点开着但今天轮不到，
 *    不是“管理员关了”）；
 *  - amount(data)：签到成功后拿到多少；
 *  - checkBody()：POST 的请求体。默认不带 body（多数分支的原生页面就是
 *    裸 POST）；Hiyo / Daigua / 小白Code 发空对象 `{}`。
 */
const SUB2API_IMPLS = [
  {
    key: "sub2api-pro",
    label: "Sub2API Pro",
    statusPath: () => "/api/v1/redeem/checkin/status",
    checkPath: () => "/api/v1/redeem/checkin",
    match: (d) => hasBooleans(d, ["enabled", "checked_in_today"]),
    enabled: (d) => d.enabled === true,
    done: (d) => d.checked_in_today === true,
    ineligible: () => false,
    amount: (d) => pickAmount(d.reward_amount, d.amount),
    extra: (d) => ({ min: pickAmount(d.reward_min), max: pickAmount(d.reward_max) }),
  },
  {
    key: "freeapi",
    label: "FreeAPI",
    // 状态和签到共用一条路径：只有 GET 带时区，POST 用干净路径
    statusPath: () => `/api/v1/user/checkin?${tzQuery()}`,
    checkPath: () => "/api/v1/user/checkin",
    match: (d) => hasBooleans(d, ["enabled", "checked_in_today"]),
    enabled: (d) => d.enabled === true,
    done: (d) => d.checked_in_today === true,
    ineligible: () => false,
    amount: (d) => pickAmount(d.amount, d.reward_amount),
    extra: (d) => ({ min: pickAmount(d.min_amount), max: pickAmount(d.max_amount), streak: toAmount(d.streak) }),
  },
  {
    key: "hiyo",
    label: "Hiyo",
    statusPath: () => `/api/v1/checkin?${tzQuery()}`,
    checkPath: () => "/api/v1/checkin",
    match: (d) => hasBooleans(d, ["enabled", "daily_claimed", "can_claim"]),
    enabled: (d) => d.enabled === true,
    done: (d) => d.daily_claimed === true,
    // 门槛没达到：不是“签到关了”，是这次参加不了
    ineligible: (d) => d.tokens_met === false,
    // 今天已领、或今天能领，才算这一轮可以签；只是“开着”不等于能签
    can: (d) => d.daily_claimed === true || (d.can_claim === true && d.daily_available !== false),
    // 原生页面 POST 空对象；body 带 type 反而会被拒
    checkBody: () => ({}),
    amount: (d) => pickAmount(d.amount, d.reward_amount),
  },
  {
    key: "toolcode",
    label: "ToolCode",
    statusPath: () => `/api/v1/engagement/checkin/status?${tzQuery()}`,
    checkPath: () => "/api/v1/engagement/checkin",
    match: (d) => hasBooleans(d, ["checkin_enabled", "checked_in_today", "can_checkin"]),
    enabled: (d) => d.checkin_enabled === true,
    done: (d) => d.checked_in_today === true,
    ineligible: () => false,
    can: (d) => d.checked_in_today === true || d.can_checkin === true,
    amount: (d) => pickAmount(d.points_reward, d.reward_amount),
    extra: (d) => ({ points: pickAmount(d.points, d.total_points, d.balance) }),
  },
  {
    key: "daigua",
    label: "Daigua",
    statusPath: () => `/api/v1/checkin/status?${tzQuery()}`,
    checkPath: () => "/api/v1/checkin",
    match: (d) => hasBooleans(d, ["enabled", "can_checkin", "luck_enabled"]),
    // admin_disabled 是管理员关掉，不是“今天签过了”
    enabled: (d) => d.enabled === true && d.unavailable_reason !== "admin_disabled",
    done: (d) =>
      d.can_checkin === false &&
      d.unavailable_reason !== "admin_disabled" &&
      (d.enabled === true || d.luck_enabled === true),
    ineligible: () => false,
    checkBody: () => ({}),
    amount: (d) => pickAmount(d.reward_amount, d.amount),
    extra: (d) => ({ luck: d.luck_enabled === true }),
  },
  {
    key: "genius",
    label: "Genius Programmer",
    statusPath: () => `/api/v1/user/checkin/status?${tzQuery()}`,
    checkPath: () => "/api/v1/user/checkin",
    // 和 Clawhud 共用路径：这家用 today_checked_in，并且带 recent_records
    match: (d) => hasBooleans(d, ["enabled", "today_checked_in"]) && !("checked_in_today" in d) && Array.isArray(d.recent_records),
    enabled: (d) => d.enabled === true,
    done: (d) => d.today_checked_in === true,
    ineligible: () => false,
    amount: (d) => pickAmount(d.reward_amount),
    extra: (d) => ({ total: pickAmount(d.total_points, d.points, d.balance), streak: toAmount(d.streak) }),
  },
  {
    key: "clawhud",
    label: "Clawhud",
    statusPath: () => `/api/v1/user/checkin/status?${tzQuery()}`,
    checkPath: () => "/api/v1/user/checkin",
    // 和 Genius 共用路径：这家用 checked_in_today，并且带 total_count/total_amount
    match: (d) => hasBooleans(d, ["enabled", "checked_in_today"]) && !("today_checked_in" in d) && hasNumber(d, "total_count") && hasNumber(d, "total_amount"),
    enabled: (d) => d.enabled === true,
    done: (d) => d.checked_in_today === true,
    ineligible: () => false,
    amount: (d) => pickAmount(d.today_amount),
    extra: (d) => ({ total: pickAmount(d.total_credits, d.credits, d.balance) }),
  },
  {
    key: "sidrune",
    label: "Sidrune",
    statusPath: () => "/api/v1/welfare/profile",
    checkPath: () => "/api/v1/welfare/checkin",
    match: (d) => hasBooleans(d, ["enabled", "eligible", "checked_in_today"]),
    // eligible=false 是“没资格”，不是“签到关了”；两个要分开报
    enabled: (d) => d.enabled === true,
    done: (d) => d.checked_in_today === true,
    ineligible: (d) => d.eligible === false,
    amount: (d) => pickAmount(d.reward_amount),
    extra: (d) => ({ streak: toAmount(d.streak_day ?? d.streak), milestone: pickAmount(d.milestone_bonus) }),
  },
]

/**
 * Denxio：两段式签到。先 begin 拿一个短时 token 和等待秒数，
 * 等完再 claim。它不在通用表格里，因为签到不是一次 POST 能完成的。
 */
const DENXIO = {
  key: "denxio",
  label: "Denxio",
  statusPath: () => `/api/v1/tbe-sponsor-checkin/status?${tzQuery()}`,
  beginPath: () => `/api/v1/tbe-sponsor-checkin/normal/begin?${tzQuery()}`,
  claimPath: () => "/api/v1/tbe-sponsor-checkin/normal/claim",
  read: (d) => {
    const config = asRecord(d.config)
    if (typeof d.normal_done !== "boolean" || typeof config?.normal_checkin_enabled !== "boolean") return undefined
    return { enabled: config.normal_checkin_enabled, done: d.normal_done }
  },
  amount: (d) => pickAmount(asRecord(d.record)?.amount),
}

/** AI-ROUTER：GET 读、POST 领，同一条路径，字段是 checked_today。 */
const AI_ROUTER = {
  key: "ai-router",
  label: "AI-ROUTER",
  // 只有 GET 带时区（站点自己的前端就这么发）；POST 用干净路径
  statusPath: () => `/api/v1/user/daily-checkin?${tzQuery()}`,
  checkPath: () => "/api/v1/user/daily-checkin",
  read: (d) => {
    if (typeof d.enabled !== "boolean" || typeof d.checked_today !== "boolean") return undefined
    if (d.eligible !== undefined && typeof d.eligible !== "boolean") return undefined
    // enabled 是站点开关，eligible 是账号门槛：两个原因要分开报
    return { enabled: d.enabled, eligible: d.eligible !== false, done: d.checked_today }
  },
  amount: (d) => pickAmount(d.reward_amount),
}

/**
 * 按各实现依次试：哪个的状态接口答得出可认的字段，就用哪个签到。
 * 返回 {outcome, credit?, message}，或 undefined（一个都不像 → 没适配）。
 */
async function checkinSub2ApiFamily(site, token, { fetchImpl, onUnauthorized } = {}) {
  const label = siteLabel(site)
  let sawAnyEndpoint = false
  let lastNetError = ""

  for (const impl of SUB2API_IMPLS) {
    const statusPath = impl.statusPath()
    const st = await probeJson(site, statusPath, { token, fetchImpl })
    if (st.error) {
      lastNetError = st.error
      continue
    }
    if (st.status === 404 || st.status === 405) continue
    sawAnyEndpoint = true
    if (st.status === 401 || st.status === 403) {
      // 端点存在但不认令牌：这家就是有签到，只是登录态过期了。
      // 还能重新登录（账号里存了密码）的话，换上新令牌再来一次。
      if (onUnauthorized) {
        const fresh = await onUnauthorized()
        if (fresh) return checkinSub2ApiFamily(site, fresh, { fetchImpl, onUnauthorized })
      }
      return {
        outcome: "failed",
        message: `${label} 的签到接口要求登录（HTTP ${st.status}${messageOf(st.body) ? ` · ${messageOf(st.body)}` : ""}），账号的登录态过期了，请重新登录一次`,
      }
    }
    const data = asRecord(unwrapData(st.body))
    if (!data || !impl.match(data)) {
      // 路径在，但字段对不上：可能只是巧合撞了路径，换下一个
      continue
    }

    const state = {
      enabled: impl.enabled(data),
      done: impl.done(data),
      ineligible: impl.ineligible(data),
      can: typeof impl.can === "function" ? impl.can(data) : true,
      ...(impl.extra?.(data) ?? {}),
    }
    const mins = state.min !== undefined && state.max !== undefined ? `${state.min}~${state.max}` : ""

    // enabled 是站点级开关：关了就只是“管理员没开”，不再往账号资格上猜
    if (!state.enabled) return adminOff(site)
    if (state.done) {
      return {
        outcome: "done",
        credit: toAmount(data.today_amount) ?? pickAmount(data.amount, data.reward_amount),
        streak: state.streak,
        message: `今日已签到${mins ? `（每天 ${mins}）` : ""}`,
      }
    }
    if (state.ineligible) {
      const reason = reasonOfBody(st.body)
      return {
        outcome: "ineligible",
        message: `${label} 说这个账号暂时没资格签到${reason ? `：${reason}` : ""}`,
      }
    }
    if (state.can === false) {
      // 站点开着签到，但今天这一轮轮不到（时间窗没到、额度用完之类）。
      // 这不是“管理员关了”，也不该硬发一次 POST 去撞。
      const reason = [reasonOfBody(st.body), messageOf(st.body)].filter(Boolean).join(" · ")
      const kind = classifyText(reason)
      if (kind === "captcha") {
        return { outcome: "captcha", message: `${label} 的签到要过人机验证，请到站点网页手动签到` }
      }
      return {
        outcome: "inactive",
        message: `${label} 现在不能签到${reason ? `：${reason}` : ""}${mins ? `（每日 ${mins}）` : ""}`,
      }
    }

    // 原生页面大多裸 POST（不带 body）；只有 Hiyo / Daigua 明确发 {}
    const body = typeof impl.checkBody === "function" ? impl.checkBody(state) : undefined
    const cr = await probeJson(site, impl.checkPath(), {
      token,
      method: "POST",
      body,
      timeout: CHECKIN_TIMEOUT,
      fetchImpl,
    })
    if (cr.error) return { outcome: "failed", message: `${label} 签到失败：${cr.error}` }
    if ((cr.status === 401 || cr.status === 403) && onUnauthorized) {
      const fresh = await onUnauthorized()
      if (fresh) return checkinSub2ApiFamily(site, fresh, { fetchImpl, onUnauthorized })
    }

    const cdata = asRecord(unwrapData(cr.body)) ?? {}
    const reason = reasonOfBody(cr.body)
    if (envelopeOk(cr)) {
      // 有的站点成功也回一个 “new_reward=false” 之类的字段，表示这条是旧记录
      if (cdata.new_reward === false) return { outcome: "done", message: "今日已签到" }
      if (cdata.alreadyChecked === true || cdata.already_checked === true) {
        return { outcome: "done", message: "今日已签到" }
      }
      const credit = impl.amount(cdata)
      return {
        outcome: "claimed",
        credit,
        streak: toAmount(cdata.streak_day ?? cdata.streak) ?? state.streak,
        message: `签到成功${credit ? `，拿到 ${credit}` : ""}`,
      }
    }

    // 专业错误码优先：它不随站点语言变
    const text = [reason, messageOf(cr.body), `HTTP ${cr.status}`].filter(Boolean).join(" · ")
    const classified = classifyMutationFailure(
      site,
      cr,
      text,
      DUPLICATE_REASONS[impl.key],
      DISABLED_REASONS[impl.key],
      FORBIDDEN_REASONS[impl.key],
    )
    // 已经能给出确定结论的，不必再回读
    if (classified.outcome !== "failed") {
      if (classified.outcome === "done") classified.credit = impl.amount(cdata)
      return classified
    }

    // 失败文案不可靠，但结果可能已经落地（请求到了、响应丢了）。
    // 再读一次状态：签上了就如实报“已签到”，不制造一次假失败。
    try {
      const after = await probeJson(site, statusPath, { token, fetchImpl })
      const d2 = asRecord(unwrapData(after.body))
      if (d2 && impl.match(d2) && impl.done(d2)) {
        return { outcome: "done", credit: toAmount(d2.today_amount) ?? impl.amount(d2), message: "今日已签到" }
      }
    } catch {}
    // 归类出来的失败文案（限流 / 登录态失效之类）比笼统的“签到失败”更有用
    return classified
  }

  if (!sawAnyEndpoint && lastNetError) {
    return { outcome: "failed", message: `${label} 连不上：${lastNetError}` }
  }
  return undefined
}

/**
 * Denxio 的两段式签到：begin → 等 wait_seconds → claim。
 * 只在状态确认「今天还没签」之后才发；失败不重放，避免重复领取。
 */
async function checkinDenxio(site, token, { fetchImpl } = {}) {
  const label = siteLabel(site)
  const st = await probeJson(site, DENXIO.statusPath(), { token, fetchImpl })
  if (st.error) return { outcome: "failed", message: `${label} 连不上：${st.error}` }
  if (st.status === 404 || st.status === 405) return undefined
  const data = asRecord(unwrapData(st.body))
  const state = data ? DENXIO.read(data) : undefined
  if (!state) return undefined
  if (!state.enabled) return adminOff(site)
  if (state.done) return done("今日已签到")

  const begin = await probeJson(site, DENXIO.beginPath(), {
    token,
    method: "POST",
    body: { timezone: TZ },
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (begin.error) return { outcome: "failed", message: `${label} 签到失败：${begin.error}` }
  const bdata = asRecord(unwrapData(begin.body)) ?? {}
  const challenge = String(bdata.token ?? "").trim()
  const waitSeconds = toAmount(bdata.wait_seconds)
  if (!envelopeOk(begin) || !challenge) {
    const text = [reasonOfBody(begin.body), messageOf(begin.body), `HTTP ${begin.status}`].filter(Boolean).join(" · ")
    return classifyMutationFailure(site, begin, text, DUPLICATE_REASONS[DENXIO.key], DISABLED_REASONS[DENXIO.key], FORBIDDEN_REASONS[DENXIO.key])
  }
  // 站点要求等待一段挑战时间；最多等 60 秒（协议自己的上限）
  const waitMs = Math.min(Math.ceil((waitSeconds ?? 0) * 1000), 60_000)
  if (waitMs > 0) await sleep(waitMs)

  const claim = await probeJson(site, DENXIO.claimPath(), {
    token,
    method: "POST",
    body: { token: challenge, timezone: TZ },
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (claim.error) return { outcome: "failed", message: `${label} 签到失败：${claim.error}` }
  const cdata = asRecord(unwrapData(claim.body)) ?? {}
  if (envelopeOk(claim)) {
    const credit = DENXIO.amount(cdata)
    return { outcome: "claimed", credit, message: `签到成功${credit ? `，拿到 ${credit}` : ""}` }
  }
  const text = [reasonOfBody(claim.body), messageOf(claim.body), `HTTP ${claim.status}`].filter(Boolean).join(" · ")
  return classifyMutationFailure(
    site,
    claim,
    text,
    DUPLICATE_REASONS[DENXIO.key],
    DISABLED_REASONS[DENXIO.key],
    FORBIDDEN_REASONS[DENXIO.key],
  )
}

/** AI-ROUTER：GET 读状态、POST 领取，日切由站点按 timezone 算。 */
async function checkinAiRouter(site, token, { fetchImpl } = {}) {
  const label = siteLabel(site)
  const st = await probeJson(site, AI_ROUTER.statusPath(), { token, fetchImpl })
  if (st.error) return { outcome: "failed", message: `${label} 连不上：${st.error}` }
  if (st.status === 404 || st.status === 405) return undefined
  const data = asRecord(unwrapData(st.body))
  const state = data ? AI_ROUTER.read(data) : undefined
  if (!state) return undefined
  if (!state.enabled) return adminOff(site)
  if (state.done) return done("今日已签到")
  if (!state.eligible) {
    // 站点开着，但账号没到门槛：站点自己的前端也不会发领取请求
    return { outcome: "ineligible", message: `${label} 说这个账号暂时没资格签到` }
  }

  const cr = await probeJson(site, AI_ROUTER.checkPath(), {
    token,
    method: "POST",
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (cr.error) return { outcome: "failed", message: `${label} 签到失败：${cr.error}` }
  const cdata = asRecord(unwrapData(cr.body)) ?? {}
  if (envelopeOk(cr)) {
    const credit = AI_ROUTER.amount(cdata)
    return { outcome: "claimed", credit, message: `签到成功${credit ? `，拿到 ${credit}` : ""}` }
  }
  const text = [reasonOfBody(cr.body), messageOf(cr.body), `HTTP ${cr.status}`].filter(Boolean).join(" · ")
  return classifyMutationFailure(
    site,
    cr,
    text,
    DUPLICATE_REASONS[AI_ROUTER.key],
    DISABLED_REASONS[AI_ROUTER.key],
    FORBIDDEN_REASONS[AI_ROUTER.key],
  )
}

/** 一次失败的 POST 的归类：专业错误码 → 文案 → 兜底。 */
function classifyMutationFailure(site, r, text, duplicates = [], disabled = [], forbidden = []) {
  const label = siteLabel(site)
  const reason = reasonOfBody(r.body)
  if (duplicates.includes(reason)) return { outcome: "done", message: "今日已签到" }
  if (disabled.includes(reason)) return adminOff(site)
  if (forbidden.includes(reason)) return { outcome: "ineligible", message: `${label} 不让这个账号签到（${reason}）` }
  const kind = classifyText(text)
  if (kind === "done") return { outcome: "done", message: "今日已签到" }
  if (kind === "disabled") return adminOff(site)
  if (kind === "captcha") return { outcome: "captcha", message: `${label} 的签到要过人机验证，请到站点网页手动签到` }
  if (kind === "ineligible") return { outcome: "ineligible", message: `${label} 不让这个账号签到：${text}` }
  if (kind === "auth") return { outcome: "failed", message: `${label} 说登录态无效：${text}，请重新登录一次` }
  if (kind === "rate") return { outcome: "failed", message: `${label} 限流了：${text}（稍后自动重试）` }
  return { outcome: "failed", message: `${label} 签到失败：${text}` }
}

/** 认 sub2api 家族：公开设置 → auth/me → 各分支的状态接口报文指纹。 */
export async function detectSub2Api(site, { token, fetchImpl } = {}) {
  const pub = await probeJson(site, "/api/v1/settings/public", { fetchImpl })
  // data 里得有东西：有的中转站在这个路径上回一句“没接入”的空信封
  if (pub.ok && asRecord(unwrapData(pub.body))) {
    return { kind: "sub2api", confidence: "high", detail: "GET /api/v1/settings/public 答了" }
  }
  const me = await probeJson(site, "/api/v1/auth/me", { token, fetchImpl })
  if (me.status === 200 || me.status === 401) {
    const body = asRecord(me.body)
    if (body && ("code" in body || "data" in body || "message" in body)) {
      return { kind: "sub2api", confidence: "high", detail: "GET /api/v1/auth/me 答了" }
    }
  }
  // 没有公开设置接口的分支站：看签到接口本身。
  // 除了标准表格，还要试 Denxio 和 AI-ROUTER 这两种独立的协议。
  for (const impl of SUB2API_IMPLS) {
    const st = await probeJson(site, impl.statusPath(), { token, fetchImpl })
    if (st.error || st.status === 404 || st.status === 405) continue
    const data = asRecord(unwrapData(st.body))
    if (data && impl.match(data)) {
      return { kind: "sub2api", confidence: "medium", detail: `${impl.statusPath()} 答了 ${impl.label} 的字段` }
    }
  }
  for (const impl of [DENXIO, AI_ROUTER]) {
    const st = await probeJson(site, impl.statusPath(), { token, fetchImpl })
    if (st.error || st.status === 404 || st.status === 405) continue
    const data = asRecord(unwrapData(st.body))
    if (data && impl.read(data)) {
      return { kind: "sub2api", confidence: "medium", detail: `${impl.label} 的状态接口答了` }
    }
  }

  // 小白Code：签到接口在 /checkin/api/*
  const xb = await probeJson(site, "/checkin/api/status", { token, fetchImpl })
  if (!xb.error && xb.status !== 404) {
    const body = asRecord(xb.body)
    const data = asRecord(body?.data) ?? asRecord(body)
    if (data && ("signedToday" in data || "config" in data)) {
      return { kind: "sub2api", confidence: "medium", detail: "/checkin/api/status 答了小白Code 的字段" }
    }
  }
  return undefined
}

/**
 * sub2api 签到。凭据可以是登录拿到的 oauth（access/refresh），
 * 也可以是手动填的 access_token。
 */
export async function checkinSub2Api(site, auth, { fetchImpl, save } = {}) {
  const label = siteLabel(site)
  let current = auth
  try {
    const r = await refreshSub2ApiAuth(auth, { fetchImpl, save })
    current = r.auth
  } catch (e) {
    return { outcome: "failed", message: `${label}：${e?.message ?? e}` }
  }
  // 注意用 || 而不是 ??：空字符串（metadata 里没填 access 时）也要回退到 key
  const token = String(current?.access || current?.key || current?.metadata?.access || "").trim()
  if (!token) {
    return { outcome: "failed", message: `${label} 没有可用的登录态，请重新登录` }
  }

  // 用 star 邮箱密码重新登录一次，拿一套新令牌（只在账号里存了密码时才有）
  const login = async () => {
    if (!auth?.email || !auth?.password) return ""
    try {
      const t = await loginSub2Api(site, { email: auth.email, password: auth.password }, { fetchImpl })
      if (!t?.access) return ""
      const next = { ...current, ...t }
      try {
        await save?.(next)
      } catch {}
      return t.access
    } catch {
      return ""
    }
  }
  const onUnauthorized = auth?.email && auth?.password ? login : undefined

  const family = await checkinSub2ApiFamily(site, token, { fetchImpl, onUnauthorized })
  if (family) return family

  // 8000 之外的两套独立协议：Denxio 两段式、AI-ROUTER 单路径
  const denxio = await checkinDenxio(site, token, { fetchImpl })
  if (denxio) return denxio
  const aiRouter = await checkinAiRouter(site, token, { fetchImpl })
  if (aiRouter) return aiRouter

  // 小白Code：签到接口在 /checkin/api/*
  const xb = await checkinXiaobaiCode(site, token, { fetchImpl, onUnauthorized })
  if (xb) return xb

  return notAdapted(site, "没认出它的签到接口")
}

/** 小白Code：/checkin/api/status + /checkin/api/checkin */
async function checkinXiaobaiCode(site, token, { fetchImpl, onUnauthorized } = {}) {
  const st = await probeJson(site, "/checkin/api/status", { token, fetchImpl })
  if (st.error || st.status === 404 || st.status === 405) return undefined
  if ((st.status === 401 || st.status === 403) && onUnauthorized) {
    const fresh = await onUnauthorized()
    if (fresh) return checkinXiaobaiCode(site, fresh, { fetchImpl })
  }
  const body = asRecord(st.body)
  const data = asRecord(body?.data) ?? asRecord(body)
  if (!data || !("signedToday" in data || "config" in data)) return undefined
  const label = siteLabel(site)
  const config = asRecord(data.config) ?? {}
  if (config.enabled === false) return adminOff(site)
  if (data.signedToday === true) return done("今日已签到")

  const cr = await probeJson(site, "/checkin/api/checkin", {
    token,
    method: "POST",
    body: {},
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (cr.error) return { outcome: "failed", message: `${label} 签到失败：${cr.error}` }
  const cbody = asRecord(cr.body)
  const cdata = asRecord(cbody?.data) ?? asRecord(cbody)
  if (cbody?.ok === true || cr.ok) {
    if (cdata?.alreadyChecked === true) return done("今日已签到")
    const record = asRecord(cdata?.record) ?? cdata
    const credit = pickAmount(record?.reward_amount, record?.amount, cdata?.amount)
    return { outcome: "claimed", credit, message: `签到成功${credit ? `，拿到 ${credit}` : ""}` }
  }
  const text = (typeof cbody?.error === "string" ? cbody.error : "") || messageOf(cr.body) || `HTTP ${cr.status}`
  const kind = classifyText(text)
  if (kind === "done") return done("今日已签到")
  if (kind === "disabled") return adminOff(site)
  if (kind === "captcha") return { outcome: "captcha", message: `${label} 的签到要过人机验证，请到网页手动签到` }
  return { outcome: "failed", message: `${label} 签到失败：${text}` }
}

// ---- 对外：认站点 + 签到 ----------------------------------------------------

/**
 * 认一个站点。
 *  - {kind:"new-api"}：签到接口需要访问令牌，
 *  - {kind:"sub2api"}：签到接口需要登录态（access token），
 *  - undefined：没适配，调用方按“未适配”如实说明。
 */
export async function detectSite(site, { token, fetchImpl } = {}) {
  const newApi = await detectNewApi(site, { token, fetchImpl })
  if (newApi) return newApi
  const sub2api = await detectSub2Api(site, { token, fetchImpl })
  if (sub2api) return sub2api
  return undefined
}

/** 按站点类型分派签到。 */
export async function checkinSite(site, auth, { fetchImpl, save } = {}) {
  // 令牌可能放在顶层（老格式的账号），也可能在 metadata 里（签到管家存的）
  const token = String(auth?.key || auth?.access || auth?.metadata?.access || "").trim()
  let detected = await detectSite(site, { token, fetchImpl })
  if (!detected && !token) {
    // 没有凭据时有的站点不肯亮出签到接口（401 / 200 空信封），带上刚存的
    // 令牌再认一次；这样先一键导入、后签到也能认出站点类型。
    const saved = String(auth?.storedKey ?? auth?.metadata?.key ?? auth?.metadata?.access ?? "").trim()
    if (saved) detected = await detectSite(site, { token: saved, fetchImpl })
  }
  if (!detected) {
    // 没认出来：先弄清是“站点本身连不上/挂了”，还是“能连上但没适配的站点”。
    // 这两种情况对用户来说要做的事完全不同。
    const probe = await requestJson(site, "/", { timeout: PROBE_TIMEOUT, fetchImpl })
    if (probe.error) {
      return { outcome: "failed", message: `${siteLabel(site)} 连不上：${probe.error}` }
    }
    if (probe.status >= 500) {
      return {
        outcome: "failed",
        message: `${siteLabel(site)} 现在打不开（HTTP ${probe.status}），站点自己出了故障或者是它前面的 CDN 挡着，过一会儿再试`,
      }
    }
    return notAdapted(site)
  }
  if (detected.kind === "new-api") {
    if (!token) {
      return {
        outcome: "failed",
        message: `${siteLabel(site)} 是 new-api 站点，签到要用访问令牌：去站点的「设置 → 访问令牌」建一个，再用「new-api 访问令牌」方式加进签到管家`,
      }
    }
    return checkinNewApi(site, token, { fetchImpl, variant: detected.variant })
  }
  if (!token) {
    return { outcome: "failed", message: `${siteLabel(site)} 没有登录态，请重新登录一次` }
  }
  return checkinSub2Api(site, auth, { fetchImpl, save })
}

/** usage 卡片用：余额 / 账号 / 今天的签到状态，读不出来给 null。 */
export async function siteSnapshot(site, auth, { fetchImpl, save } = {}) {
  const token = String(auth?.key || auth?.access || auth?.metadata?.access || "").trim()
  const out = { site, display: displayUrl(site), kind: "", error: "" }
  try {
    const detected = await detectSite(site, { token, fetchImpl })
    if (!detected) {
      out.kind = "unknown"
      // 和签到一样分清“站点连不上/挂了”和“能连上但没适配”：卡片上这两种
      // 情况要让人做的事完全不同
      const probe = await requestJson(site, "/", { timeout: PROBE_TIMEOUT, fetchImpl })
      out.error = probe.error
        ? `连不上：${probe.error}`
        : probe.status >= 500
          ? `站点现在打不开（HTTP ${probe.status}），过一会儿再试`
          : "签到管家暂未适配这个站点"
      return out
    }
    out.kind = detected.kind
    out.checkinEnabled = detected.checkinEnabled
    if (detected.kind === "new-api") {
      // 签到状态和余额是两个接口：状态读不出（业务错误）只影响“今天签没签”，
      // 余额仍然照读；令牌本身被拒时两边都会给 authError，卡片标“要重新登录”。
      const status = await newApiStatus(site, token, { fetchImpl, variant: detected.variant }).catch((e) => {
        out.error = e?.message ?? String(e)
        if (e?.kind === "auth") out.signIn = "expired"
        return undefined
      })
      if (status) {
        out.checkinEnabled = status.enabled
        out.today = status.today
        out.todayCredit = status.todayCredit
        out.totalCheckins = status.totalCheckins
        out.totalQuota = status.totalQuota
        if (status.authError) {
          out.signIn = "expired"
          out.error = "访问令牌失效了，去站点「设置 → 访问令牌」重新生成一个"
        }
      }
      const self = await newApiBalance(site, token, { fetchImpl }).catch((e) => ({ error: e?.message ?? String(e) }))
      if (self.error) {
        // 余额读不到不算签到失败，也不值得在卡片上亮红字：分支站的
        // /api/user/self 常常被改过或被令牌权限挡住。只有签到状态那边也
        // 说令牌不作数时，才把账号标成要重新登录（上面已经标了）。
      } else {
        if (self.balance !== undefined) out.balance = self.balance
        if (self.unit) out.balanceUnit = self.unit
        if (self.user) out.user = self.user
      }
      return out
    }
    // sub2api：把几个可能的余额/状态接口读一读（读不到不算错）
    const { auth: fresh, renewed } = await refreshSub2ApiAuth(auth, { fetchImpl, save })
    if (renewed) out.signIn = "renewed"
    const t = String(fresh?.access ?? "").trim()
    const me = await probeJson(site, "/api/v1/auth/me", { token: t, fetchImpl })
    if (me.error) {
      if (!out.error) out.error = `连不上：${me.error}`
      return out
    }
    if (me.status === 401 || me.status === 403) {
      out.signIn = "expired"
      out.error = "登录态失效了，请重新登录这个站点"
    }
    if (me.ok) {
      const d = asRecord(unwrapData(me.body)) ?? {}
      out.user = String(d.email ?? d.username ?? asRecord(d.user)?.email ?? "").trim()
      const bal = asRecord(d.balance) ?? {}
      const amount = pickAmount(bal.amount, d.balance, d.credits, d.quota)
      if (amount !== undefined) out.balance = amount
      const unit = String(bal.unit ?? d.balance_unit ?? "").trim()
      if (unit) out.balanceUnit = unit
    }
    return out
  } catch (e) {
    out.error = e?.message ?? String(e)
    if (e?.kind === "auth") out.signIn = "expired"
    return out
  }
}

export { httpSummary }
