// Usage 卡片：一个账号一张卡，字段全用 magpie 自己的额度结构。
//
// 卡片只回答“这个账号还剩什么”：
//  - user     账号（备注名 · 站点认出来的账号）
//  - plan     套餐名（只有站点真给了订阅套餐才有）
//  - windows  额度窗口，magpie 画成进度条（new-api 的额度、sub2api 的 5h/1d/7d）
//  - balance  余额，站点只给一个数时就靠它
//  - until    到期时间
// 这些字段 magpie 会自己排版、自己翻译、自己根据设置决定显示“已用”还是“剩余”，
// 也会拿 balance 和窗口百分比去做额度提醒——所以这里给的是数字和标准字段，
// 不是一句写死的中文长句。

import { asRecord, rateLimitSeconds, siteKeyOf, siteLabel } from "./core.mjs"
import { getAccountState } from "./store.mjs"
import { detectSite } from "./detect.mjs"
import { readNewApi } from "./newapi.mjs"
import { readSub2Api } from "./sub2api.mjs"

// 卡片会被 magpie 反复刷新（打开设置、切标签、定时刷新）。每次刷新都往站点
// 发请求，等于替用户轮询人家，小站会被打成限流。所以同一个账号的结果缓存几分钟：
// 余额晚几分钟不碍事，站点压力小一大截。出错只缓存两分钟，恢复后能较快显示正常。
// 只缓存真实请求的结果；测试注入 fetchImpl 时（以及站点正在退避时）不缓存。
const SNAPSHOT_TTL = 5 * 60_000
const SNAPSHOT_TTL_ERROR = 2 * 60_000
const snapshots = new Map() // `${accountId}|${站点}` -> { at, ttl, value }

/** 仅供测试：清空卡片缓存。 */
export function resetUsageCache() {
  snapshots.clear()
}

const text = (v) => String(v ?? "").trim()

/** 账号记录 → 读额度要用的凭据。 */
function credentialsOf(auth) {
  const a = asRecord(auth) ?? {}
  return {
    key: text(a.key),
    access: text(a.metadata?.access ?? a.access),
    refresh: text(a.metadata?.refresh ?? a.refresh),
    expires: Number(a.metadata?.expires ?? a.expires) || 0,
    email: text(a.metadata?.email),
    password: String(a.metadata?.password ?? ""),
  }
}

/**
 * 卡片上的账号行：用户给的备注名就是账号名；没有备注名时用站点认出来的
 * 账号（补上主机名，免得几张卡看起来一模一样）。
 */
function cardUser(site, snap, stored, me) {
  const host = siteLabel(site)
  const named = text(stored.name) || text(me?.metadata?.name)
  if (named) return named
  const account = text(snap.account)
  if (account && account !== host) return `${host} · ${account}`
  return host
}

/**
 * 一个账号的 usage 卡片。
 * getAuth 拿当前账号的凭据；已经拿过的话可以用 auth 传进来，省一次调用。
 * accountId 是 magpie 的账号名（provider 或 provider#xxxx）。
 */
export async function usageFor(getAuth, { directory, accountId, fetchImpl, save, auth } = {}) {
  const me = auth ?? (await getAuth()) ?? {}
  const site = text(me.site ?? me.metadata?.site)
  const stored = getAccountState(directory, accountId)
  if (!site) return { error: "账号里没记站点地址，请移除后重新添加", user: accountId || "" }

  const cacheable = !fetchImpl && rateLimitSeconds(site) <= 0
  const cacheKey = `${accountId ?? ""}|${siteKeyOf(site) || site}`
  if (cacheable) {
    const hit = snapshots.get(cacheKey)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
  }

  // 这个站点刚回过 429：一张“没适配”的卡会误导人，如实说是限流
  const wait = rateLimitSeconds(site)
  if (wait > 0) {
    return { user: cardUser(site, {}, stored, me), error: `${siteLabel(site)} 刚才限流了，${wait} 秒后再读额度` }
  }

  // 站点类型记在账号状态里；老账号没记过就看凭据里的，再没有就现探一次
  let kind = text(stored.kind) || text(me.metadata?.kind)
  if (kind !== "new-api" && kind !== "sub2api") {
    kind = (await detectSite(site, { fetchImpl }))?.kind ?? ""
  }

  const cred = credentialsOf(me)
  const read = (k) =>
    k === "new-api"
      ? readNewApi(site, cred.key || cred.access, { fetchImpl })
      : readSub2Api(site, cred, { fetchImpl, save })

  // 记下的类型先试；它说“不认这个接口/这个凭据”时再试另一家——公开接口
  // 认不出来的站点（前置网关、Cloudflare 拦截）靠这一步仍然能读出额度。
  // 类型没记过时：没有 API 密钥、只有 JWT 的分明是登录令牌，先按 sub2api 读。
  const jwtOnly = !cred.key && cred.access.split(".").length === 3
  const first = kind || (jwtOnly ? "sub2api" : "new-api")
  const order = [first, first === "new-api" ? "sub2api" : "new-api"]
  let snap
  let rejected
  for (const k of order) {
    const out = await read(k)
    if (out.unrecognized) continue
    if (out.rejected) {
      rejected ??= out
      continue
    }
    snap = out
    break
  }
  // 两家都说“不认这个凭据”：那是凭据的问题（站点已确认），交给 magpie 标重登
  snap ??= rejected
  snap ??= { error: `${siteLabel(site)} 没认出是 new-api 还是 sub2api，读不了额度` }

  const card = {
    user: cardUser(site, snap, stored, me),
    ...(snap.plan ? { plan: snap.plan } : {}),
    ...(snap.balance ? { balance: snap.balance } : {}),
    ...(snap.windows?.length ? { windows: snap.windows } : {}),
    ...(snap.until ? { until: snap.until } : {}),
    ...(snap.renew ? { renew: snap.renew } : {}),
    ...(snap.error ? { error: snap.error } : {}),
    ...(snap.signIn ? { signIn: snap.signIn } : {}),
  }

  if (cacheable) {
    const transient = !!snap.error || !!snap.signIn
    snapshots.set(cacheKey, { at: Date.now(), ttl: transient ? SNAPSHOT_TTL_ERROR : SNAPSHOT_TTL, value: card })
  }
  return card
}
