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
 * 这个站点是不是 new-api（或它的分支：Veloera、voapi 等）。
 *
 * 判据从硬到软：
 *  1. GET /api/status 里有 checkin_enabled —— new-api 自己的字段，最可靠；
 *  2. GET /api/user/checkin 用访问令牌拿到 {success,data:{enabled,…}} —— 带鉴权的确认；
 *  3. GET /api/user/checkin 不带令牌回 401 且响应像 new-api 的信封。
 * 返回 {kind, confidence, checkinEnabled?, version?, detail} 或 undefined。
 */
export async function detectNewApi(site, { token, fetchImpl } = {}) {
  const status = await probeJson(site, "/api/status", { fetchImpl })
  if (status.ok) {
    const d = asRecord(unwrapData(status.body))
    if (d && "checkin_enabled" in d) {
      return {
        kind: "new-api",
        confidence: "high",
        checkinEnabled: d.checkin_enabled === true,
        version: typeof d.version === "string" ? d.version : "",
        siteName: typeof d.system_name === "string" ? d.system_name : "",
        detail: "GET /api/status 里有 checkin_enabled",
      }
    }
  }
  // 有的站点把 /api/status 换掉了，用签到接口本身再确认一次
  const probe = await probeJson(site, `/api/user/checkin?month=${monthOf()}`, { token, fetchImpl })
  const data = asRecord(unwrapData(probe.body))
  if (data && ("enabled" in data || "stats" in data)) {
    return {
      kind: "new-api",
      confidence: "high",
      checkinEnabled: data.enabled !== false,
      detail: "GET /api/user/checkin 返回了签到状态",
    }
  }
  if (probe.status === 401 && asRecord(probe.body)?.success === false) {
    return { kind: "new-api", confidence: "medium", detail: "GET /api/user/checkin 要求登录" }
  }
  // 有的站点（或它前面的网关）把「未登录」「令牌无效」也当成 200 回，
  // 但 body 是 new-api 的信封：success=false + 英文文案。没有其它站点
  // 长这样，可以据此认下来。认不出来时调用方会带真实令牌再试一次。
  if (probe.status === 200 && asRecord(probe.body)?.success === false) {
    return { kind: "new-api", confidence: "medium", detail: "GET /api/user/checkin 回了 new-api 风格的错误信封" }
  }
  // 没带令牌又明确说“签到没开”
  if (probe.ok && isDisabledText(messageOf(probe.body))) {
    return { kind: "new-api", confidence: "medium", checkinEnabled: false, detail: "签到接口说未开启" }
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
 */
export async function newApiStatus(site, token, { fetchImpl } = {}) {
  const r = await probeJson(site, `/api/user/checkin?month=${monthOf()}`, { token, fetchImpl })
  if (r.error) throw new SiteError(`读签到状态失败：${r.error}（${siteLabel(site)} 连不上）`)
  if (r.status === 401 || r.status === 403) {
    throw new SiteError(
      `读签到状态失败：站点不认这个访问令牌（HTTP ${r.status}${messageOf(r.body) ? ` · ${messageOf(r.body)}` : ""}）`,
      { kind: "auth" },
    )
  }
  if (!envelopeOk(r)) {
    const text = messageOf(r.body) || `HTTP ${r.status}`
    // 管理员关掉时，new-api 的签到接口就是这么回的
    if (isDisabledText(text)) return { enabled: false, site }
    throw new SiteError(`读签到状态失败：${text}`)
  }
  const data = asRecord(unwrapData(r.body)) ?? {}
  const stats = asRecord(data.stats) ?? {}
  const records = Array.isArray(stats.records) ? stats.records : []
  const today = beijingDay()
  const todayRecord = records.find((x) => String(asRecord(x)?.checkin_date ?? "") === today)
  const enabled = data.enabled !== false
  return {
    enabled,
    site,
    today: stats.checked_in_today === true || !!todayRecord,
    todayCredit: toAmount(todayRecord?.quota_awarded),
    checkinCount: toAmount(stats.checkin_count),
    totalCheckins: toAmount(stats.total_checkins),
    totalQuota: toAmount(stats.total_quota),
    minQuota: toAmount(data.min_quota),
    maxQuota: toAmount(data.max_quota),
  }
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
 * 返回 {outcome, credit?, message}。
 */
export async function checkinNewApi(site, token, { fetchImpl } = {}) {
  const label = siteLabel(site)
  if (!token) {
    return { outcome: "failed", message: "没有访问令牌，签到需要先在站点里建一个" }
  }

  // 先读状态：能一次分清“管理员没开”“今天已签”“可以直接签”
  let status
  try {
    status = await newApiStatus(site, token, { fetchImpl })
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
  if (status.today) {
    return {
      outcome: "done",
      credit: status.todayCredit,
      message: `今日已签到${status.todayCredit ? `，今天拿到 ${status.todayCredit} 额度` : ""}`,
    }
  }

  const r = await requestJson(site, "/api/user/checkin", {
    method: "POST",
    headers: bearer(token),
    body: {},
    timeout: CHECKIN_TIMEOUT,
    fetchImpl,
  })
  if (r.error) return { outcome: "failed", message: `${label} 连不上：${r.error}` }

  const data = asRecord(unwrapData(r.body)) ?? {}
  if (envelopeOk(r)) {
    const credit = toAmount(data.quota_awarded) ?? toAmount(data.quota)
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
    return { outcome: "done", credit: toAmount(data.quota_awarded), message: "今日已签到" }
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
// 每个实现声明自己的状态接口、签到接口，和怎么读里面的字段；下面那个
// 通用引擎负责走流程和把结果翻译成 magpie 的 outcome。

/**
 * 一个实现的字段读法：
 *  state(data) → {enabled?, done?, can?, min?, max?, reason?, amount?}
 *  用 undefined 表示“这个实现不在这台站点上”。
 */
const SUB2API_IMPLS = [
  {
    key: "sub2api-pro",
    label: "Sub2API Pro",
    statusPath: () => "/api/v1/redeem/checkin/status",
    checkPath: () => "/api/v1/redeem/checkin",
    read: (d) => {
      if (!("enabled" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.checked_in_today === true,
        min: pickAmount(d.reward_min, d.min_amount),
        max: pickAmount(d.reward_max, d.max_amount),
        total: pickAmount(d.total_reward),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.amount, d.reward_amount, d.quota_awarded, d.credits),
  },
  {
    key: "freeapi",
    label: "FreeAPI",
    statusPath: () => `/api/v1/user/checkin?timezone=${TZ}`,
    checkPath: () => `/api/v1/user/checkin?timezone=${TZ}`,
    read: (d) => {
      if (!("enabled" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.checked_in_today === true,
        min: pickAmount(d.min_amount),
        max: pickAmount(d.max_amount),
        total: pickAmount(d.total_amount),
        streak: toAmount(d.streak),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.amount, d.reward_amount, d.quota_awarded),
  },
  {
    key: "hiyo",
    label: "Hiyo",
    statusPath: () => `/api/v1/checkin?timezone=${TZ}`,
    checkPath: () => `/api/v1/checkin?timezone=${TZ}`,
    read: (d) => {
      if (!("enabled" in d) && !("daily_claimed" in d) && !("can_claim" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.daily_claimed === true,
        can: typeof d.can_claim === "boolean" ? d.can_claim : undefined,
        // 有门槛没达到：不是“签到关了”，是这次参加不了
        ineligible: d.tokens_met === false,
        balance: pickAmount(d.balance, d.tokens, d.total_tokens),
        reason: String(d.unavailable_reason ?? d.reason ?? ""),
      }
    },
    checkBody: () => ({ type: "daily" }),
    amount: (d) => pickAmount(d.amount, d.reward_amount, d.tokens, d.reward),
  },
  {
    key: "toolcode",
    label: "ToolCode",
    statusPath: () => `/api/v1/engagement/checkin/status?timezone=${TZ}`,
    checkPath: () => "/api/v1/engagement/checkin",
    read: (d) => {
      if (!("checkin_enabled" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.checkin_enabled !== false,
        done: d.checked_in_today === true,
        can: typeof d.can_checkin === "boolean" ? d.can_checkin : undefined,
        points: pickAmount(d.points, d.total_points, d.balance),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.points_reward, d.reward_amount, d.points, d.amount),
  },
  {
    key: "daigua",
    label: "Daigua",
    statusPath: () => `/api/v1/checkin/status?timezone=${TZ}`,
    checkPath: () => "/api/v1/checkin",
    read: (d) => {
      if (!("enabled" in d) && !("can_checkin" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.checked_in_today === true || d.can_checkin === false,
        can: typeof d.can_checkin === "boolean" ? d.can_checkin : undefined,
        luck: d.luck_enabled === true,
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    checkBody: () => ({ checkin_type: "normal" }),
    amount: (d) => pickAmount(d.reward_amount, d.amount, d.points),
  },
  {
    key: "genius",
    label: "Genius Programmer",
    statusPath: () => `/api/v1/user/checkin/status?timezone=${TZ}`,
    checkPath: () => "/api/v1/user/checkin",
    read: (d) => {
      if (!("enabled" in d) && !("today_checked_in" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.today_checked_in === true || d.checked_in_today === true,
        total: pickAmount(d.total_points, d.points, d.balance),
        streak: toAmount(d.streak),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.new_reward, d.reward_amount, d.points, d.amount),
  },
  {
    key: "clawhud",
    label: "Clawhud",
    statusPath: () => `/api/v1/user/checkin/status?timezone=${TZ}`,
    checkPath: () => "/api/v1/user/checkin",
    read: (d) => {
      if (!("enabled" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.checked_in_today === true || d.today_checked_in === true,
        total: pickAmount(d.total_credits, d.credits, d.balance),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.today_amount, d.amount, d.reward_amount),
  },
  {
    key: "sidrune",
    label: "Sidrune",
    statusPath: () => "/api/v1/welfare/profile",
    checkPath: () => "/api/v1/welfare/checkin",
    read: (d) => {
      if (!("enabled" in d) && !("eligible" in d) && !("checked_in_today" in d)) return undefined
      return {
        enabled: d.enabled !== false,
        done: d.checked_in_today === true,
        ineligible: d.eligible === false,
        streak: toAmount(d.streak ?? d.streak_day),
        reason: String(d.unavailable_reason ?? ""),
      }
    },
    amount: (d) => pickAmount(d.reward_amount, d.amount, d.milestone_bonus),
  },
]

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
        if (fresh) return checkinSub2ApiFamily(site, fresh, { fetchImpl })
      }
      return {
        outcome: "failed",
        message: `${label} 的签到接口要求登录（HTTP ${st.status}${messageOf(st.body) ? ` · ${messageOf(st.body)}` : ""}），账号的登录态过期了，请重新登录一次`,
      }
    }
    const data = asRecord(unwrapData(st.body))
    const state = data ? impl.read(data) : undefined
    if (!state) {
      // 路径在，但字段对不上：可能只是巧合撞了路径，换下一个
      continue
    }

    const mins = state.min !== undefined && state.max !== undefined ? `${state.min}~${state.max}` : ""
    if (!state.enabled) return adminOff(site)
    if (state.reason && !state.done) {
      const kind = classifyText(state.reason)
      if (kind === "disabled") return adminOff(site)
    }
    if (state.ineligible) {
      return {
        outcome: "ineligible",
        message: `${label} 说这个账号暂时没资格签到${state.reason ? `：${state.reason}` : ""}`,
      }
    }
    if (state.done) {
      return {
        outcome: "done",
        credit: toAmount(data.today_amount) ?? toAmount(data.amount),
        streak: state.streak,
        message: `今日已签到${mins ? `（每天 ${mins}）` : ""}`,
      }
    }
    if (state.can === false) {
      const kind = classifyText(state.reason)
      if (kind === "captcha") {
        return { outcome: "captcha", message: `${label} 的签到要过人机验证，请到站点网页手动签到` }
      }
      return {
        outcome: "inactive",
        message: `${label} 现在不能签到${state.reason ? `：${state.reason}` : ""}（每日 ${mins || "奖励"}）`,
      }
    }

    const body = typeof impl.checkBody === "function" ? impl.checkBody(state) : {}
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
      if (fresh) return checkinSub2ApiFamily(site, fresh, { fetchImpl })
    }

    const cdata = asRecord(unwrapData(cr.body)) ?? {}
    if (envelopeOk(cr)) {
      const credit = impl.amount(cdata)
      return {
        outcome: "claimed",
        credit,
        streak: toAmount(cdata.streak_day ?? cdata.streak) ?? state.streak,
        message: `签到成功${credit ? `，拿到 ${credit}` : ""}`,
      }
    }

    const text = [reasonOfBody(cr.body), messageOf(cr.body), `HTTP ${cr.status}`].filter(Boolean).join(" · ")
    const kind = classifyText(text)
    if (kind === "done") return { outcome: "done", credit: impl.amount(cdata), message: "今日已签到" }
    if (kind === "disabled") return adminOff(site)
    if (kind === "captcha") {
      return { outcome: "captcha", message: `${label} 的签到要过人机验证，请到站点网页手动签到` }
    }
    if (kind === "ineligible") {
      return { outcome: "ineligible", message: `${label} 不让这个账号签到：${text}` }
    }
    if (kind === "auth") {
      return { outcome: "failed", message: `${label} 说登录态无效：${text}，请重新登录一次` }
    }
    if (kind === "rate") return { outcome: "failed", message: `${label} 限流了：${text}（稍后自动重试）` }
    return { outcome: "failed", message: `${label} 签到失败：${text}` }
  }

  if (!sawAnyEndpoint && lastNetError) {
    return { outcome: "failed", message: `${label} 连不上：${lastNetError}` }
  }
  return undefined
}

/** Sidrune 这类站点的签到状态在 /api/v1/welfare/profile，单独给 sub2api 用不上 */
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
  // 没有公开设置接口的分支站：看签到接口本身
  for (const impl of SUB2API_IMPLS) {
    const st = await probeJson(site, impl.statusPath(), { token, fetchImpl })
    if (st.error || st.status === 404 || st.status === 405) continue
    const data = asRecord(unwrapData(st.body))
    if (data && impl.read(data)) {
      return { kind: "sub2api", confidence: "medium", detail: `${impl.statusPath()} 答了 ${impl.label} 的字段` }
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

  // 8000 之外的小白Code：签到接口在 /checkin/api/*
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
    return checkinNewApi(site, token, { fetchImpl })
  }
  if (!token) {
    return { outcome: "failed", message: `${siteLabel(site)} 没有登录态，请重新登录一次` }
  }
  return checkinSub2Api(site, auth, { fetchImpl, save })
}

/** usage 卡片用：余额 / 今天的签到状态，读不出来给 null。 */
export async function siteSnapshot(site, auth, { fetchImpl, save } = {}) {
  const token = String(auth?.key || auth?.access || auth?.metadata?.access || "").trim()
  const out = { site, display: displayUrl(site), kind: "", error: "" }
  try {
    const detected = await detectSite(site, { token, fetchImpl })
    if (!detected) {
      out.kind = "unknown"
      out.error = `签到管家暂未适配 ${siteLabel(site)}`
      return out
    }
    out.kind = detected.kind
    out.checkinEnabled = detected.checkinEnabled
    if (detected.kind === "new-api") {
      const st = await newApiStatus(site, token, { fetchImpl })
      out.checkinEnabled = st.enabled
      out.today = st.today
      out.todayCredit = st.todayCredit
      out.totalCheckins = st.totalCheckins
      out.totalQuota = st.totalQuota
      return out
    }
    // sub2api：把几个可能的余额/状态接口读一读（读不到不算错）
    const { auth: fresh } = await refreshSub2ApiAuth(auth, { fetchImpl, save })
    const t = String(fresh?.access ?? "").trim()
    const me = await probeJson(site, "/api/v1/auth/me", { token: t, fetchImpl })
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
    return out
  }
}

export { httpSummary }
