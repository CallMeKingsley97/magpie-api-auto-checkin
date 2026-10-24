// 认出站点是 new-api 还是 sub2api。
//
// 只看公开接口：new-api 的 /api/status 不要求密钥，答的是站点设置
// （quota_per_unit、system_name 这类）；sub2api 公开的
// /api/v1/settings/public 答站点设置，而它的 /api/status 是登录后的接口。
// 认出来的站点类型缓存 6 小时，认不出来的 2 小时；只有站点真的回话了才缓存，
// 连不上（DNS、超时）下次还值得再试。测试注入的 fetchImpl 不进缓存。

import { asRecord, rateLimitSeconds, requestJson, siteRootOf, unwrapData } from "./core.mjs"

const PROBE_TIMEOUT = 8000
const DETECT_TTL_KNOWN = 6 * 60 * 60 * 1000
const DETECT_TTL_UNKNOWN = 2 * 60 * 60 * 1000

const cache = new Map() // 站点根 -> { at, ttl, value }
const inflight = new Map() // 站点根 -> Promise

/** 仅供测试：清空探测缓存。 */
export function resetDetectCache() {
  cache.clear()
  inflight.clear()
}

const cacheKeyOf = (site) => siteRootOf(site) || String(site ?? "").trim()

/**
 * 请求一个公开接口，按 match 认领它答的东西。
 * 返回 {data, responded}：responded 说站点到底有没有回话（404/401 也算回话，
 * 连不上、超时不算），用来决定“认不出来”要不要缓存。
 */
async function answers(site, path, match, { fetchImpl } = {}) {
  const r = await requestJson(site, path, { timeout: PROBE_TIMEOUT, fetchImpl })
  if (r.error) return { responded: false }
  if (!r.ok) return { responded: true }
  const data = asRecord(unwrapData(r.body))
  return { responded: true, data: data && match(data) ? data : undefined }
}

/**
 * 认一个站点：{kind: "new-api"|"sub2api", ...}，认不出来时 undefined。
 * 调用方按“未适配”如实说明，不猜、不试探着乱发请求。
 */
export async function detectSite(site, { fetchImpl } = {}) {
  const key = cacheKeyOf(site)
  if (!key) return undefined
  const cacheable = !fetchImpl
  if (cacheable) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
    const running = inflight.get(key)
    if (running) return running
  }
  // 这个站点刚回过 429：探测只会火上浇油
  if (rateLimitSeconds(site) > 0) return undefined

  // 站点到底有没有回话：只有回过话，才把“认不出来”也缓存下来
  let answered = false
  const probe = async (path, match) => {
    const out = await answers(site, path, match, { fetchImpl })
    if (out.responded) answered = true
    return out.data
  }

  const run = async () => {
    const na = await probe(
      "/api/status",
      (d) =>
        // new-api 的 /api/status 一定有 quota_per_unit；分支站字段有多有少，
        // 命中任意一个都算（sub2api 的这个路径要登录，不会误判）
        ["quota_per_unit", "system_name", "checkin_enabled", "announcements_enabled", "faq_enabled", "enable_drawing"].some(
          (k) => k in d,
        ),
    )
    if (na) return { kind: "new-api", status: na }
    const s2 = await probe("/api/v1/settings/public", (d) => Object.keys(d).length > 0)
    if (s2) return { kind: "sub2api", settings: s2 }
    return undefined
  }

  if (!cacheable) return run()
  const task = run()
    .then((value) => {
      if (value || answered) {
        cache.set(key, { at: Date.now(), ttl: value ? DETECT_TTL_KNOWN : DETECT_TTL_UNKNOWN, value })
      }
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}
