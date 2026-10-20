// 签到管家（Auto Check-in）：magpie 插件
//
// 把 magpie 里每一个 new-api / sub2api 中转站都签到一遍。
//  - 账号：一个账号 = 一个站点 + 一份凭据（new-api 用访问令牌，sub2api 用登录态）
//  - 批量导入：把 providers.json 里已经配好的站点一次性搬进来，凭据就是那条 provider 的 key
//  - 签到：magpie 每天（北京时间）自动跑一遍，结果在 Usage 卡片、`magpie accounts checkin`
//  - 签不了的，逐条说清是哪种情况：没适配 / 管理员没开 / 已签 / 要人机验证 / 认证失败 / 网络问题
//
// 只读 magpie 自己的配置文件，只把请求发往用户自己配置的那些站点；日志里不写密钥。

import path from "node:path"

import { asRecord, httpSummary, requestJson, siteKeyOf, siteLabel, siteRootOf } from "./lib/core.mjs"
import { PLUGIN_ID, patchAccountState, putAuthAccount, dropAuthAccount, isPluginAccountShape, readJsonFile, recordResult, loadProviderSites, registeredSites, authFilePath } from "./lib/store.mjs"
import { checkinSite, detectSite, loginSub2Api } from "./lib/checkin.mjs"
import { usageFor } from "./lib/usage.mjs"

const PROVIDER_ID = PLUGIN_ID
const PROVIDER_NAME = "签到管家"

// 声明过的开关（auth.options）；用户的值在 settings.json 的 pluginOptions 里
const OPTION_KEYS = { showProviderScan: "show_provider_scan" }

export default {
  id: PLUGIN_ID,
  async server(input) {
    const client = input?.client
    const directory = input?.directory
    const magpieOption = (key) => {
      try {
        return input?.magpie?.option?.(PROVIDER_ID, key) === true
      } catch {
        return false
      }
    }

    const log = async (level, message) => {
      try {
        await client?.app?.log?.({ body: { service: PLUGIN_ID, level, message: String(message) } })
      } catch {}
    }

    // ---- 账号登记簿 --------------------------------------------------------
    //
    // magpie 把每个账号记在自己的 key 下（第一个是 provider id，其余是
    // id#xxxxxx）；账号挂在哪个站点、叫什么名字，记在 state.json 里。

    /** 账号名 = provider id（第一个账号）或 provider#xxxx（其余）。 */
    /**
     * 账号名 = provider id（第一个账号）或 provider#xxxx（其余）。
     * 只认“有站点信息”的账号：以前版本或许留下过只有一个令牌的半个账号，
     * 不该让它占着名字、让后来的站点被记成第二个。
     */
    function accountKeyFor() {
      const all = readAuthFile()
      const keys = Object.keys(all).filter(
        (k) => (k === PROVIDER_ID || k.startsWith(PROVIDER_ID + "#")) && isPluginAccountShape(all[k]),
      )
      const usedIds = new Set(keys.map((k) => String(asRecord(all[k])?.accountId ?? "").trim()).filter(Boolean))
      if (!keys.includes(PROVIDER_ID)) return PROVIDER_ID
      for (;;) {
        const k = `${PROVIDER_ID}#${Math.random().toString(36).slice(2, 8)}`
        if (k in all || usedIds.has(k)) continue
        return k
      }
    }

    /** 直接读插件的 auth 文件，只为了给账号排序、去重（不写）。 */
    function readAuthFile() {
      const v = readJsonFile(authFilePath(directory))
      return asRecord(v) ?? {}
    }

    /**
     * 这个站点已经登记过的话，它在 auth 文件里的 key。
     * 重新添加同一个站点（比如换了令牌）要改这一条，不能再开一条：
     * 同一站点堆两条账号，签到列表里就会重复，还各自记一份签到状态。
     */
    function accountKeyForSite(site) {
      const want = siteKeyOf(site)
      if (!want) return ""
      const all = readAuthFile()
      for (const k of pluginAccountKeys(all)) {
        const a = asRecord(all[k])
        if (!isPluginAccountShape(a)) continue
        if (siteKeyOf(String(a.metadata?.site ?? a.site ?? "")) === want) return k
      }
      return ""
    }

    /** 本插件自己的账号（按 agent 名字或 site 找条目时用得到）。 */
    function pluginAccountKeys(all = readAuthFile()) {
      return Object.keys(all).filter((k) => k === PROVIDER_ID || k.startsWith(PROVIDER_ID + "#"))
    }

    /** 能签到、能展示的账号：读不懂的条目跳过（但不动它们）。 */
    function accountsIn(all = readAuthFile()) {
      return pluginAccountKeys(all)
        .filter((k) => isPluginAccountShape(all[k]))
        .map((k) => ({ key: k, auth: asRecord(all[k]) ?? {} }))
    }

    function currentAccounts() {
      return accountsIn().sort((a, b) => (a.key === PROVIDER_ID ? -1 : b.key === PROVIDER_ID ? 1 : a.key < b.key ? -1 : 1))
    }

    /**
     * 把一个账号写进 plugin-auth.json。不在登录流程里时（导入/添加站点），
     * 不能走 client.auth.set（会写到 provider 自己那一个 key 上）。
     */
    function saveAccountFile(key, body) {
      const ok = putAuthAccount(directory, key, body)
      if (!ok) log("error", "写 plugin-auth.json 失败（文件可能正被占用或读不出来），这次没有保存")
      return ok
    }

    /**
     * 更新已有账号的凭据（sub2api 续期后用）。
     * 保住原有的账号名和 metadata，只改新的令牌；写坏了也留住旧的，
     * 不能因为一次续期把账号的站点信息搞丢。
     */
    function saveAuthUpdate(key, cred) {
      const all = readAuthFile()
      const cur = asRecord(all[key])
      if (!cur) return false
      const body = {
        ...cur,
        ...(cred?.access ? { key: cred.access } : {}),
        metadata: {
          ...(asRecord(cur.metadata) ?? {}),
          ...(cred?.access ? { access: cred.access } : {}),
          ...(cred?.refresh ? { refresh: cred.refresh } : {}),
          ...(cred?.expires ? { expires: cred.expires } : {}),
        },
      }
      return saveAccountFile(key, body)
    }

    /**
     * 一条账号记录 → 签到要用的凭据。
     * 两条签到路径（magpie 每日自动的 checkin 钩子、手动 action=checkin）共用，
     * 免得一边带上了邮箱密码、另一边没带，sub2api 令牌过期时表现不一样。
     */
    function credentialsOf(auth) {
      const a = asRecord(auth) ?? {}
      return {
        key: String(a.key ?? "").trim(),
        access: String(a.metadata?.access ?? a.access ?? "").trim(),
        refresh: String(a.metadata?.refresh ?? a.refresh ?? "").trim(),
        expires: Number(a.metadata?.expires ?? a.expires) || 0,
        // sub2api 用邮箱密码登录的账号：留一份密码，令牌过期时能自动重新登录
        email: String(a.metadata?.email ?? "").trim(),
        password: String(a.metadata?.password ?? ""),
        site: String(a.site ?? a.metadata?.site ?? "").trim(),
      }
    }

    /**
     * 凭 magpie 给的凭据反查它在 auth 文件里的 key（账号名就是 accountId）。
     * usage 钩子只拿到 getAuth，没有 key，续期时要靠这个找回落点。
     */
    function accountKeyOf(auth) {
      const want = String(asRecord(auth)?.accountId ?? "").trim()
      if (!want) return ""
      const all = readAuthFile()
      for (const k of pluginAccountKeys(all)) {
        if (String(asRecord(all[k])?.accountId ?? "").trim() === want) return k
      }
      return ""
    }

    // ---- 账号登记簿 --------------------------------------------------------
    async function importProviders({ dryRun = false } = {}) {
      const known = new Set(registeredSites(directory).map((s) => s.key))
      const sites = loadProviderSites(directory)
      const added = []
      for (const s of sites) {
        if (known.has(s.key)) continue
        if (!s.hasKey) continue
        if (dryRun) {
          added.push({ site: s.site, name: s.name, source: s.source, action: "会导入" })
          continue
        }
        // 凭据直接读 providers.json 里那条 provider 的 key（用户已经配好的）
        const provider = findProviderRecord(s)
        if (!provider?.key) continue
        const detected = await detectSite(s.site, { token: provider.key }).catch(() => undefined)
        const kind = detected?.kind ?? "unknown"
        const accountKey = accountKeyFor()
        const body = {
          type: "api",
          key: String(provider.key),
          accountId: s.name,
          metadata: { site: s.site, name: s.name, source: "providers.json", kind, provider: s.providerIds[0] ?? "" },
        }
        if (!saveAccountFile(accountKey, body)) continue
        patchAccountState(directory, accountKey, {
          site: s.site,
          name: s.name,
          kind,
          source: "providers.json",
        })
        recordResult(directory, accountKey, {
          outcome: "inactive",
          message: detected
            ? `已导入（认出来是 ${kind === "new-api" ? "new-api" : "sub2api"} 站点，还没签到）`
            : `已导入，但还没认出站点类型（${siteLabel(s.site)}）`,
        })
        added.push({ site: s.site, name: s.name, account: accountKey, kind, action: "已导入" })
        known.add(s.key)
      }
      return added
    }

    /** 在 providers.json / plugin-providers.json 里找一条 provider 记录。 */
    function findProviderRecord(siteEntry) {
      for (const file of ["providers.json", "plugin-providers.json"]) {
        const data = readJsonFile(path.join(directory, file))
        const list = Array.isArray(data) ? data : Array.isArray(data?.providers) ? data.providers : Array.isArray(data?.plugins) ? data.plugins : []
        for (const p of list) {
          const r = asRecord(p)
          if (!r) continue
          const id = String(r.id ?? r.name ?? "")
          if (siteEntry.providerIds.includes(id) && typeof r.key === "string" && r.key) return r
        }
      }
      return undefined
    }

    /**
     * 新增/更新一个站点。token 给了就直接用；只给了邮箱密码就往 sub2api 登录。
     * 返回一句给人看的结果。
     */
    async function addSite({ site, token, email, password, name, kind }) {
      const root = siteRootOf(site)
      if (!root) return { ok: false, message: `站点地址看不懂：${site}` }
      const detected = await detectSite(root, { token: token || undefined })
      const resolvedKind = detected?.kind ?? (kind === "new-api" || kind === "sub2api" ? kind : "")

      if (!detected) {
        return {
          ok: false,
          message: `${siteLabel(root)} 没认出是 new-api 还是 sub2api，插件暂时没法给它签到。请确认地址正确、填的是站点首页；如果站点改过地址或换了签到接口，欢迎到仓库提 issue 说明这个站点。`,
        }
      }

      if (token) {
        // 令牌方式：先验一下这个令牌对得上
        const probe = await requestJson(root, resolvedKind === "new-api" ? "/api/user/self" : "/api/v1/auth/me", {
          headers: { Authorization: `Bearer ${String(token).trim()}` },
        })
        if (probe.status === 401 || probe.status === 403) {
          return {
            ok: false,
            message: `${siteLabel(root)} 不认这个令牌（HTTP ${probe.status}${probe.body ? ` · ${httpSummary(probe).split("：")[1] ?? ""}` : ""}）。new-api 要用「设置 → 访问令牌」建的令牌，sub2api 用登录返回的 access token`,
          }
        }
        if (probe.error) return { ok: false, message: `${siteLabel(root)} 连不上：${probe.error}` }
        const label = name || accountLabelFromProbe(probe, root)
        const key = accountKeyForSite(root) || accountKeyFor()
        const body = {
          type: "api",
          key: String(token).trim(),
          accountId: label,
          metadata: { site: root, name: label, kind: resolvedKind, source: "manual" },
        }
        if (!saveAccountFile(key, body)) {
          return { ok: false, message: "读到 magpie 的账号文件时出了问题，这次没有写入。请稍后再试一次。" }
        }
        patchAccountState(directory, key, { site: root, name: label, kind: resolvedKind, source: "manual" })
        return {
          ok: true,
          account: key,
          message: `已加入 ${label}（${resolvedKind}${detected?.checkinEnabled === false ? "，但管理员没开签到" : ""}）`,
        }
      }

      if (resolvedKind !== "sub2api") {
        return {
          ok: false,
          message: `${siteLabel(root)} 是 new-api 站点，不支持账号密码登录（它没有稳定的登录接口）。请到站点里生成「访问令牌」后填进来。`,
        }
      }
      if (!email || !password) {
        return { ok: false, message: "sub2api 站点需要邮箱和密码，或直接填一个 access token" }
      }
      try {
        const tokens = await loginSub2Api(root, { email, password })
        const label = name || tokens.accountId || siteLabel(root)
        const key = accountKeyForSite(root) || accountKeyFor()
        const body = {
          type: "api",
          key: tokens.access,
          accountId: label,
          metadata: {
            site: root,
            name: label,
            kind: "sub2api",
            source: "login",
            // 邮箱密码留着：令牌过期时能自动重新登录，不用你手动补
            email: String(email ?? "").trim(),
            password: String(password ?? ""),
            ...(tokens.uid ? { uid: tokens.uid } : {}),
            ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
            ...(tokens.expires ? { expires: tokens.expires } : {}),
          },
        }
        if (!saveAccountFile(key, body)) {
          return { ok: false, message: "登录成功了，但写 magpie 的账号文件时出了问题。请到「设置 → 账号」手动加一次，或稍后重试。" }
        }
        patchAccountState(directory, key, { site: root, name: label, kind: "sub2api", source: "login" })
        return { ok: true, account: key, message: `已登录 ${label} 并加入签到管家（令牌会过期，到期会自动重新登录）` }
      } catch (e) {
        return { ok: false, message: `登录失败：${e?.message ?? e}` }
      }
    }

    function accountLabelFromProbe(probe, root) {
      const d = asRecord(probe.body)
      const data = asRecord(d?.data) ?? d ?? {}
      const user = asRecord(data.user) ?? data
      return String(user?.email ?? user?.username ?? user?.display_name ?? "").trim() || siteLabel(root)
    }

    // ---- 签到 --------------------------------------------------------------

    /** magpie 的 checkin 钩子：当前账号签一次。 */
    async function checkinCurrent(getAuth) {
      const auth = asRecord(await getAuth()) ?? {}
      const site = String(auth.site ?? auth.metadata?.site ?? "").trim()
      const accountId = String(auth.accountId ?? "").trim()
      if (!site) {
        return { outcome: "failed", message: "这个账号里没记站点地址，请移除后重新添加" }
      }
      const cred = credentialsOf(auth)
      if (!cred.key && !cred.access) {
        return { outcome: "failed", message: `${siteLabel(site)} 的账号没有令牌，请重新添加` }
      }
      // 续期/重登后的新令牌写回这个账号在 auth 文件里的那一条（按 accountId 反查）
      const fileKey = accountKeyOf(auth) || accountId
      // 签到状态记在 auth 文件的那个 key 上：手动签到（checkinAll）也写同一处，
      // 两边都按它读，usage 卡片才不会说“今天没签”而其实签过了
      const stateKey = fileKey || accountId
      try {
        const result = await checkinSite(site, cred, { save: (c) => saveAuthUpdate(fileKey, c) })
        recordResult(directory, stateKey, result)
        return result
      } catch (e) {
        const message = `${siteLabel(site)}：${e?.message ?? e}`
        recordResult(directory, stateKey, { outcome: "failed", message })
        return { outcome: "failed", message }
      }
    }

    /** 签到所有账号，返回一份可以打出来的清单。 */
    async function checkinAll({ only = "", fetchImpl, quiet = false } = {}) {
      const accounts = currentAccounts()
      const results = []
      for (const a of accounts) {
        const site = String(a.auth.site ?? a.auth.metadata?.site ?? "").trim()
        const name = String(a.auth.accountId ?? a.auth.metadata?.name ?? a.key)
        if (only && !(name === only || a.key === only || siteKeyOf(site) === siteKeyOf(only))) continue
        if (!site) {
          results.push({ account: a.key, name, site: "", outcome: "failed", message: "账号里没记站点地址" })
          continue
        }
        let result
        try {
          result = await checkinSite(site, credentialsOf(a.auth), {
            fetchImpl,
            save: (c) => saveAuthUpdate(a.key, c),
          })
        } catch (e) {
          result = { outcome: "failed", message: `${siteLabel(site)}：${e?.message ?? e}` }
        }
        recordResult(directory, a.key, result)
        results.push({ account: a.key, name, site, ...result })
      }
      return results
    }

    // CLI / 工具输出里用 magpie 自己的符号习惯（↻、× 这类），不用 emoji：
    // 终端字体和等宽表格里 emoji 会把行高撑开。
    function resultLine(r) {
      const label = r.name || siteLabel(r.site) || r.account
      const mark = { claimed: "✓", done: "✓", inactive: "·", ineligible: "·", captcha: "!", failed: "✕" }[r.outcome] ?? "·"
      const credit =
        typeof r.credit === "number" && r.credit > 0 && !String(r.message ?? "").includes(String(r.credit))
          ? `（+${r.credit}）`
          : ""
      return `${mark} ${label}：${r.message || r.outcome}${credit}`
    }

    function reportText(results) {
      if (!results.length) {
        return "签到管家还没有任何账号。先在 Providers 里点「签到管家」添加站点，或让我执行「一键导入 Provider」把现有的中转站都搬进来。"
      }
      const named = [
        ["claimed", "签到成功"],
        ["done", "今日已签"],
        ["inactive", "未开启"],
        ["ineligible", "无资格"],
        ["captcha", "要验证码"],
        ["failed", "失败"],
      ]
      const counts = new Map()
      for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
      const parts = named.filter(([k]) => counts.get(k)).map(([k, name]) => `${name} ${counts.get(k)}`)
      // 出现表里没有的 outcome 也照实报，不悄悄吞掉
      for (const [k, n] of counts) if (!named.some(([known]) => known === k)) parts.push(`${k} ${n}`)
      return [`共 ${results.length} 个站点：${parts.join("，")}`, ...results.map(resultLine)].join("\n")
    }

    /**
     * 把用量/余额整理成一张卡片：站点类型 + 账号 + 余额。
     * 今天签没签不在这里重复——magpie 会用同一个账号的 plugin-checkin
     * 记录在卡片下面画签到行。这里先读一次凭据，按它在 auth 文件里的 key
     * 查 state.json 里用户给站点起的名字。
     */
    async function usageCard(getAuth) {
      let auth
      try {
        auth = asRecord(await getAuth()) ?? {}
      } catch {
        auth = {}
      }
      const fileKey = accountKeyOf(auth)
      const key = fileKey || String(auth.accountId ?? auth.metadata?.name ?? "").trim()
      return usageFor(getAuth, { directory, accountId: key, auth, save: (c) => saveAuthUpdate(fileKey, c) })
    }

    // ---- 给 agent 用的动作 --------------------------------------------------
    //
    // magpie 会把 tool 钩子里的工具挂到插件工具的 MCP server 上，agent 直接就能调。

    /** 列出所有站点与账号：providers.json 里有什么、已经导入了哪些。 */
    async function listSites() {
      const known = registeredSites(directory)
      const knownKeys = new Set(known.map((s) => s.key))
      const rows = loadProviderSites(directory).map((s) => ({
        site: s.site,
        name: s.name,
        from: s.source,
        providers: s.providerIds,
        hasKey: s.hasKey,
        imported: knownKeys.has(s.key),
      }))
      const accounts = currentAccounts().map((a) => ({
        account: a.key,
        site: String(a.auth.site ?? a.auth.metadata?.site ?? ""),
        name: String(a.auth.accountId ?? a.auth.metadata?.name ?? ""),
        kind: String(a.auth.metadata?.kind ?? ""),
      }))
      return {
        accounts,
        sites: rows,
        unimported: rows.filter((r) => !r.imported),
        hint:
          "添加一个站点：action=add，给出 site 和 token（new-api 用访问令牌，sub2api 用登录令牌）；" +
          "sub2api 也可以给 email + password 直接登录。" +
          "一键导入 providers.json 里已有的中转站：action=import。",
      }
    }

    /** 一键导入 providers.json / plugin-providers.json 里还没进来的站点。 */
    async function importAll() {
      const added = await importProviders({})
      return {
        added,
        message: added.length
          ? `导入了 ${added.length} 个站点。接着跑一次 action=checkin 看看结果吧。`
          : "没有可导入的站点（要么都导入过了，要么那些 provider 里没有带 key 的中转站）。",
      }
    }

    /** 现在就签一遍。account 留空 = 全部。 */
    async function checkinNow({ account = "" } = {}) {
      const only = String(account ?? "").trim()
      const results = await checkinAll({ only: only && only !== "all" ? only : "" })
      return { results, report: reportText(results) }
    }

    /** 把一个账号移出签到管家（只是不再签到，站点上的账号不受影响）。 */
    async function removeAccount({ account = "" } = {}) {
      const key = String(account ?? "").trim()
      if (!key) return { ok: false, message: "要给出账号名" }
      // 能删的包括读不出站点信息的“半条账号”：正好用来打扫
      if (!pluginAccountKeys().includes(key)) return { ok: false, message: `没有这个账号：${key}` }
      if (!dropAuthAccount(directory, key)) {
        return { ok: false, message: `没能移除 ${key}（账号文件读不出来或本来就不在）` }
      }
      return { ok: true, message: `已移除 ${key}（站点上的账号不受影响）` }
    }

    // ---- 插件导出 ----------------------------------------------------------

    /** magpie 在开发模式下会把钩子里的异常打出来（见 provider-plugins 文档）。 */
    async function safety(what, fn) {
      try {
        return await fn()
      } catch (e) {
        log("error", `${what} 时出错：${e?.message ?? e}`)
        return undefined
      }
    }

    return {
      /**
       * magpie 每次拼请求配置时都会叫一次。这里给签到管家安一个 provider 壳子：
       * 地址用 plugin:// 开头（magpie 认得，不会真去联网），名字显示成「签到管家」，
       * 这样它在列表里是显式的、而不是缺省的一行灰字。
       */
      config: async (config) =>
        safety("拼配置", () => {
          config.provider ??= {}
          config.provider[PLUGIN_ID] = {
            name: PROVIDER_NAME,
            api: `plugin://${PLUGIN_ID}`,
            ...(config.provider[PLUGIN_ID] ?? {}),
          }

          if (magpieOption(OPTION_KEYS.showProviderScan)) {
            const sites = loadProviderSites(directory)
            const known = new Set(registeredSites(directory).map((s) => s.key))
            const fresh = sites.filter((s) => !known.has(s.key))
            if (fresh.length) {
              log(
                "info",
                `发现 ${fresh.length} 个还没加入签到管家的站点：${fresh
                  .slice(0, 8)
                  .map((s) => s.name)
                  .join("、")}${fresh.length > 8 ? " 等" : ""}。可以对 agent 说“把没导入的站点导入签到管家”。`,
              )
            }
          }
        }),

      auth: {
        provider: PROVIDER_ID,
        label: PROVIDER_NAME,
        // 日历打勾的线稿图标（24×24、圆角端点），颜色在浅色和深色卡片上都够亮；
        // magpie 把它当图片画，不能用 currentColor
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTZhMzRhIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMy41IiB5PSI0LjUiIHdpZHRoPSIxNyIgaGVpZ2h0PSIxNiIgcng9IjMiLz48cGF0aCBkPSJNOCAyLjV2NE0xNiAyLjV2NE0zLjUgOS41aDE3Ii8+PHBhdGggZD0ibTggMTQuOCAyLjYgMi42IDUuMi01LjQiLz48L3N2Zz4=",
        options: [
          {
            key: OPTION_KEYS.showProviderScan,
            label: "启动时检查其它 Provider",
            description:
              "启动时看一眼 providers.json 里还有哪些站点没加进来，在日志里提一句。只读地址，不碰凭据；这个开关本身不会导入任何东西。",
            default: false,
          },
        ],

        methods: [
          {
            type: "api",
            label: "new-api 访问令牌",
            prompts: [
              {
                type: "text",
                key: "site",
                message: "站点地址",
                placeholder: "https://example.com",
                validate: (v) => (siteRootOf(v) ? undefined : "请填完整网址，例如 https://example.com"),
              },
              {
                type: "password",
                key: "token",
                message: "访问令牌（站点 → 设置 → 访问令牌）",
                placeholder: "粘贴访问令牌；旧式令牌和 nap_ 令牌都行",
              },
              { type: "text", key: "name", message: "备注名（留空用域名）", placeholder: "可选" },
            ],
            async authorize(inputs = {}) {
              const site = siteRootOf(inputs.site)
              if (!site) return { type: "failed", error: "站点地址看不懂，请填完整网址" }
              const token = String(inputs.token ?? "").trim()
              if (!token) return { type: "failed", error: "没有填访问令牌" }
              const detected = await detectSite(site, { token }).catch((e) => {
                return { error: e?.message ?? String(e) }
              })
              if (detected?.error) return { type: "failed", error: `连不上 ${siteLabel(site)}：${detected.error}` }
              if (!detected) {
                return {
                  type: "failed",
                  error: `${siteLabel(site)} 没认出是 new-api 还是 sub2api 站点，插件暂时没法给它签到`,
                }
              }
              // 用令牌读一次自己的信息，验证令牌
              const probe = await requestJson(site, detected.kind === "new-api" ? "/api/user/self" : "/api/v1/auth/me", {
                headers: { Authorization: `Bearer ${token}` },
              })
              if (probe.status === 401 || probe.status === 403) {
                return {
                  type: "failed",
                  error:
                    `${siteLabel(site)} 不认这个令牌（HTTP ${probe.status}${probe.body ? ` · ${httpSummary(probe).split("：")[1] ?? ""}` : ""}）。` +
                    (detected.kind === "new-api"
                      ? "请确认用的是访问令牌（不是 API 密钥）：站点 → 设置 → 访问令牌"
                      : "请确认用的是登录后的 access token"),
                }
              }
              if (probe.error) return { type: "failed", error: `${siteLabel(site)} 连不上：${probe.error}` }
              const name = String(inputs.name ?? "").trim() || accountLabelFromProbe(probe, site)
              const accountId = name
              return {
                type: "success",
                key: token,
                accountId,
                metadata: { site, name, kind: detected.kind, source: "manual", checkinEnabled: detected.checkinEnabled },
              }
            },
          },
          {
            type: "api",
            label: "sub2api 邮箱密码",
            prompts: [
              {
                type: "text",
                key: "site",
                message: "站点地址",
                placeholder: "https://example.com",
                validate: (v) => (siteRootOf(v) ? undefined : "请填完整网址，例如 https://example.com"),
              },
              { type: "text", key: "email", message: "登录邮箱", placeholder: "you@example.com" },
              { type: "password", key: "password", message: "登录密码" },
              { type: "text", key: "name", message: "备注名（留空用邮箱）", placeholder: "可选" },
            ],
            async authorize(inputs = {}) {
              const site = siteRootOf(inputs.site)
              if (!site) return { type: "failed", error: "站点地址看不懂，请填完整网址" }
              try {
                const tokens = await loginSub2Api(site, { email: inputs.email, password: inputs.password })
                const name = String(inputs.name ?? "").trim() || tokens.accountId || siteLabel(site)
                return {
                  type: "success",
                  key: tokens.access,
                  accountId: name,
                  metadata: {
                    site,
                    name,
                    kind: "sub2api",
                    source: "login",
                    // 邮箱密码留着：令牌过期时能自动重新登录
                    email: String(inputs.email ?? "").trim(),
                    password: String(inputs.password ?? ""),
                    ...(tokens.uid ? { uid: tokens.uid } : {}),
                    ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
                    ...(tokens.expires ? { expires: tokens.expires } : {}),
                  },
                }
              } catch (e) {
                return { type: "failed", error: e?.message ?? String(e) }
              }
            },
          },
          {
            type: "api",
            label: "sub2api 登录令牌",
            prompts: [
              {
                type: "text",
                key: "site",
                message: "站点地址",
                placeholder: "https://example.com",
                validate: (v) => (siteRootOf(v) ? undefined : "请填完整网址，例如 https://example.com"),
              },
              { type: "password", key: "token", message: "登录令牌 access token（浏览器开发者工具里复制）" },
              { type: "text", key: "name", message: "备注名（留空用域名）", placeholder: "可选" },
            ],
            async authorize(inputs = {}) {
              const site = siteRootOf(inputs.site)
              const token = String(inputs.token ?? "").trim()
              if (!site) return { type: "failed", error: "站点地址看不懂，请填完整网址" }
              if (!token) return { type: "failed", error: "没有填令牌" }
              const detected = await detectSite(site, { token }).catch(() => undefined)
              const probe = await requestJson(site, "/api/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } })
              if (probe.error) return { type: "failed", error: `${siteLabel(site)} 连不上：${probe.error}` }
              if (probe.status === 401 || probe.status === 403) {
                return { type: "failed", error: `${siteLabel(site)} 不认这个令牌（HTTP ${probe.status}）` }
              }
              const name = String(inputs.name ?? "").trim() || accountLabelFromProbe(probe, site)
              return {
                type: "success",
                key: token,
                accountId: name,
                metadata: { site, name, kind: detected?.kind ?? "sub2api", source: "token" },
              }
            },
          },
        ],

        /** magpie 每次用到账号前会问一次；签到管家不需要额外准备什么。 */
        async loader() {
          return {}
        },

        usage: (getAuth) => safety("读用量", () => usageCard(getAuth)),

        checkin: (getAuth) => safety("签到", () => checkinCurrent(getAuth)),
      },

      tool: {
        manage_checkin: {
          description:
            "签到管家：列出/导入 magpie 里配置的中转站（new-api、sub2api）并立即签到。" +
            "action=providers 列出站点与账号；action=import 一键导入 providers.json 里的站点；" +
            "action=add 添加一个站点（site、token 或 email/password）；action=checkin 立即签到（account 可选）；" +
            "action=remove 移除一个账号。",
          args: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["providers", "import", "add", "checkin", "remove"] },
              site: { type: "string", description: "站点地址，例如 https://example.com" },
              token: { type: "string", description: "站点凭据：new-api 访问令牌 / sub2api access token" },
              email: { type: "string" },
              password: { type: "string" },
              name: { type: "string" },
              account: { type: "string", description: "要签到的账号名，留空为全部" },
            },
            required: ["action"],
          },
          async execute(args = {}) {
            const action = String(args.action ?? "")
            try {
              if (action === "providers") return { output: JSON.stringify(await listSites(), null, 2) }
              if (action === "import") {
                const out = await importAll()
                return { output: `${out.message}\n\n${JSON.stringify(out.added, null, 2)}` }
              }
              if (action === "add") {
                const out = await addSite(args)
                return { output: out.message ?? JSON.stringify(out, null, 2) }
              }
              if (action === "checkin") {
                const out = await checkinNow({ account: args.account })
                return { output: out.report }
              }
              if (action === "remove") {
                const out = await removeAccount({ account: args.account })
                return { output: out.message ?? JSON.stringify(out, null, 2) }
              }
              return { output: "action 要是 providers / import / add / checkin / remove 之一" }
            } catch (e) {
              return { output: `这一步没做成：${e?.message ?? e}` }
            }
          },
        },
      },
    }
  },
}
