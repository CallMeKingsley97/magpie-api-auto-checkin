// Usage 卡片：一个账号一张卡，只放 magpie 自己会排版的东西。
//
// 卡片上有三样就够：这是哪个站点/账号（user）、是什么站点类型（plan）、
// 还剩多少（balance）。今天签没签、拿了多少奖励，magpie 会在卡片下面画
// 自己的签到行（plugin-checkin.json），这里不再重复一遍——重复会让一张
// 小卡塞满“站点：… · 类型：… · 今天签到拿了：…”这样的长句子。

import { getAccountState } from "./store.mjs"
import { siteSnapshot } from "./checkin.mjs"
import { siteLabel } from "./core.mjs"

/** 各站点类型在卡片上的名字（也是 plan 徽标）。 */
const KIND_NAMES = {
  "new-api": "new-api",
  sub2api: "sub2api",
  unknown: "未适配",
}

const text = (v) => String(v ?? "").trim()

/** 余额数字：整数就整数，小数最多两位，不去掉有意义的小数位。 */
function amountText(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return ""
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

/**
 * 卡片上的账号行。优先用用户给站点起的名字，其次是站点认出来的账号；
 * 只有账号（手动登录的常见情况）时补上主机名，免得几张卡看起来一模一样。
 */
function cardUser(site, snap, stored) {
  const host = siteLabel(site)
  const siteName = text(stored.name)
  const account = text(snap.user)
  const parts = []
  if (siteName) parts.push(siteName)
  if (account && account !== siteName) parts.push(account)
  if (!parts.length) parts.push(host)
  if (parts.length === 1 && parts[0] === account && account !== host) parts.unshift(host)
  return parts.join(" · ")
}

/** 余额一行；没有余额就不显示（magpie 会跳过空字段）。 */
function balanceText(snap) {
  const n = amountText(snap.balance)
  // 0 也是真实余额（额度用完了），不能当成“没读到”
  if (!n) return ""
  return `${n}${snap.balanceUnit ? ` ${snap.balanceUnit}` : ""}`
}

/**
 * 一个账号的 usage 卡片。
 * getAuth 拿当前账号的凭据；已经拿过的话可以用 auth 传进来，省一次调用。
 * accountId 是 magpie 的账号名（provider 或 provider#xxxx）。
 */
export async function usageFor(getAuth, { directory, accountId, fetchImpl, save, auth } = {}) {
  const me = auth ?? (await getAuth()) ?? {}
  const site = String(me.site ?? me.metadata?.site ?? "").trim()
  const stored = getAccountState(directory, accountId)
  if (!site) {
    return { error: "账号里没记站点地址，请移除后重新添加", user: accountId || "" }
  }

  const snap = await siteSnapshot(site, me, { fetchImpl, save })

  // 站点根本没回话时，magpie 只会在卡片下面显示一行灰字；把主机名写进
  // 报错里，才看得出是哪个站点连不上。其余报错（没适配、令牌失效）已经
  // 够短，保持原样。
  const error = snap.error && !snap.error.includes(siteLabel(site)) && /连不上|打不开/.test(snap.error)
    ? `${siteLabel(site)} ${snap.error}`
    : snap.error

  return {
    plan: KIND_NAMES[snap.kind] || "",
    user: cardUser(site, snap, stored),
    balance: balanceText(snap),
    ...(error ? { error } : {}),
    // 令牌被站点拒绝时，让 magpie 把账号标成“要重新登录”，而不是只给一张
    // 看不懂的报错卡
    ...(snap.signIn ? { signIn: snap.signIn } : {}),
  }
}
