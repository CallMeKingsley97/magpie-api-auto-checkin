// Usage 卡片：一个账号一张卡，显示它是哪个站点、余额、今天的签到情况。

import { beijingToday, checkedToday, getAccountState } from "./store.mjs"
import { siteSnapshot } from "./checkin.mjs"
import { asRecord } from "./core.mjs"

/** 各站点类型在卡片上的名字。 */
const KIND_NAMES = {
  "new-api": "new-api",
  sub2api: "sub2api",
  unknown: "未适配",
}

/** 签到结果的 outcome → 一句人话。 */
export const OUTCOME_TEXT = {
  claimed: "今天已签到",
  done: "今天已签到",
  ineligible: "账号没资格签到",
  inactive: "当前不能签到",
  captcha: "需要在站点网页手动签到（人机验证）",
  failed: "签到失败",
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
  const last = asRecord(stored.last)
  const checkedNow = checkedToday(directory, accountId)
  const kindName = KIND_NAMES[snap.kind] || ""

  const lines = []
  lines.push(`站点：${site.replace(/^https?:\/\//, "")}`)
  if (kindName) lines.push(`类型：${kindName}（签到管家认出来的）`)
  if (snap.user) lines.push(`账号：${snap.user}`)
  if (snap.balance !== undefined) {
    lines.push(`余额：${snap.balance}${snap.balanceUnit ? ` ${snap.balanceUnit}` : ""}`)
  }
  if (snap.kind === "new-api") {
    if (snap.checkinEnabled === false) lines.push("站点签到：管理员没开")
    else if (snap.checkinEnabled === true) lines.push("站点签到：开着")
    if (snap.today && snap.todayCredit) lines.push(`今天签到拿了：${snap.todayCredit} 额度`)
    if (snap.totalCheckins) lines.push(`累计签到：${snap.totalCheckins} 次`)
    if (snap.totalQuota) lines.push(`签到累计：${snap.totalQuota} 额度`)
  }
  if (last) {
    const day = String(last.day ?? "")
    const outcome = String(last.outcome ?? "")
    const when = day === beijingToday() ? "今天" : day
    lines.push(`上次签到：${when} ${OUTCOME_TEXT[outcome] ?? outcome}${last.message ? ` · ${last.message}` : ""}`)
  } else if (checkedNow) {
    lines.push("今天已签到")
  }

  const error = snap.error || ""
  const card = {
    plan: kindName || "签到管家",
    user: snap.user || stored.name || accountId || "",
    windows: [],
    balance: snap.balance !== undefined
      ? `${snap.balance}${snap.balanceUnit ? ` ${snap.balanceUnit}` : ""} · ${lines[0]}`
      : lines.join(" · "),
    renew: "auto",
    ...(error ? { error } : {}),
  }
  return card
}
