// 额度管家（Quota Manager）：magpie 插件
//
// 把 magpie 里配好的 new-api / sub2api 站点，额度读进 magpie 自己的 Usage 卡片。
//  - 账号：一个账号 = 一个站点 + 一份凭据（new-api 用 sk-… 令牌，sub2api 用
//    API 密钥或登录令牌）
//  - 批量导入：把 providers.json 里已经配好的站点一次性搬进来，凭据就是那条
//    provider 的 key
//  - 卡片：套餐、额度窗口、余额、到期时间都用 magpie 的结构化字段交出去，
//    由 magpie 自己排版、翻译、做额度提醒
//
// 只读 magpie 自己的配置文件，只把请求发往用户自己配置的那些站点；日志里不写密钥。

import path from "node:path"

import { asRecord, httpSummary, requestJson, siteKeyOf, siteLabel, siteRootOf } from "./lib/core.mjs"
import { PLUGIN_ID, patchAccountState, putAuthAccount, dropAuthAccount, isPluginAccountShape, readJsonFile, loadProviderSites, registeredSites, authFilePath } from "./lib/store.mjs"
import { detectSite } from "./lib/detect.mjs"
import { loginSub2Api } from "./lib/sub2api.mjs"
import { usageFor } from "./lib/usage.mjs"

const PROVIDER_ID = PLUGIN_ID
const PROVIDER_NAME = "额度管家"

// 声明过的开关（auth.options）；用户的值在 settings.json 的 pluginOptions 里
const OPTION_KEYS = { showProviderScan: "show_provider_scan" }

// config 钩子在 magpie 每次拼请求配置时都会被叫到；扫一眼 providers.json
// 虽然只是读本地文件，也没必要每秒读好几遍。十分钟看一次足够了。
const PROVIDER_SCAN_INTERVAL = 10 * 60 * 1000
let lastProviderScanAt = 0

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
     * 同一站点堆两条账号，列表里就会重复，还各自记一份状态。
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

    /** 能展示的账号：读不懂的条目跳过（但不动它们）。 */
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
        const detected = await detectSite(s.site).catch(() => undefined)
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

    /** 试一下凭据能不能读额度：new-api 读令牌额度，sub2api 读 /v1/usage 或登录资料。 */
    async function probeToken(site, kind, token) {
      const t = String(token ?? "").trim()
      const out = (r, hint) => ({
        ...r,
        rejected: r.status === 401 || r.status === 403,
        // 404 / 别的站点的信封：这条凭据不是给这个接口用的
        unrecognized: r.status === 404 || r.status === 405,
        hint,
      })
      if (kind === "new-api") {
        const r = await requestJson(site, "/api/usage/token/", { headers: { Authorization: `Bearer ${t}` } })
        return out(r, "new-api 要用站点「令牌」页建的 sk-… 令牌")
      }
      // JWT 是登录令牌，不是网关的 API 密钥
      if (!t.includes(".")) {
        const r = await requestJson(site, "/v1/usage", { headers: { Authorization: `Bearer ${t}` } })
        return out(r, "sub2api 要用站点里建的 sk-… API 密钥")
      }
      const r = await requestJson(site, "/api/v1/auth/me", { headers: { Authorization: `Bearer ${t}` } })
      return out(r, "请确认用的是登录后的 access token")
    }

    /** 用凭据试两种读法，返回能读通的那一种（以及探测回答）。 */
    async function probeCredential(site, token, preferred) {
      const first = preferred || (String(token).includes(".") ? "sub2api" : "new-api")
      let firstProbe
      for (const kind of [first, first === "new-api" ? "sub2api" : "new-api"]) {
        const probe = await probeToken(site, kind, token)
        if (probe.error) return { kind, probe }
        if (probe.rejected || probe.unrecognized) {
          firstProbe ??= { kind, probe }
          continue
        }
        return { kind, probe }
      }
      // 两种读法都不认：按记下的类型给一句最贴近的说明
      return firstProbe
    }

    /**
     * 新增/更新一个站点。token 给了就直接用；只给了邮箱密码就往 sub2api 登录。
     * 返回一句给人看的结果。
     */
    async function addSite({ site, token, email, password, name, kind }) {
      const root = siteRootOf(site)
      if (!root) return { ok: false, message: `站点地址看不懂：${site}` }
      const detected = await detectSite(root)
      const resolvedKind = detected?.kind ?? (kind === "new-api" || kind === "sub2api" ? kind : "")

      if (token) {
        // 公开接口认不出来的站点（前置网关、Cloudflare 拦截）也照样能加：
        // 凭据本身能不能读通，比站点指纹更算数
        const { kind: probedKind, probe } = await probeCredential(root, token, resolvedKind)
        if (probe.error) return { ok: false, message: `${siteLabel(root)} 连不上：${probe.error}` }
        if (probe.rejected) {
          return { ok: false, message: `${siteLabel(root)} 不认这个凭据（HTTP ${probe.status}）。${probe.hint}` }
        }
        if (probe.unrecognized) {
          return {
            ok: false,
            message: `${siteLabel(root)} 没有可用的额度接口（HTTP ${probe.status}）：new-api 用 /api/usage/token/，sub2api 用 /v1/usage。请确认地址填的是站点根地址。`,
          }
        }
        const finalKind = resolvedKind || probedKind
        const label = name || accountLabelFromProbe(probe, root)
        const key = accountKeyForSite(root) || accountKeyFor()
        const body = {
          type: "api",
          key: String(token).trim(),
          accountId: label,
          metadata: { site: root, name: label, kind: finalKind, source: "manual" },
        }
        if (!saveAccountFile(key, body)) {
          return { ok: false, message: "读到 magpie 的账号文件时出了问题，这次没有写入。请稍后再试一次。" }
        }
        patchAccountState(directory, key, { site: root, name: label, kind: finalKind, source: "manual" })
        return { ok: true, account: key, message: `已加入 ${label}（${finalKind}）` }
      }

      if (!detected) {
        return {
          ok: false,
          message: `${siteLabel(root)} 没认出是 new-api 还是 sub2api，插件暂时读不了它的额度。请确认地址正确、填的是站点首页；如果站点换了接口，欢迎到仓库提 issue 说明这个站点。`,
        }
      }
      if (resolvedKind !== "sub2api") {
        return {
          ok: false,
          message: `${siteLabel(root)} 是 new-api 站点，不支持账号密码登录（它没有稳定的登录接口）。请到站点的「令牌」页建一把 sk-… 令牌后填进来。`,
        }
      }
      if (!email || !password) {
        return { ok: false, message: "sub2api 站点需要邮箱和密码，或直接填一个 API 密钥 / access token" }
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
        return { ok: true, account: key, message: `已登录 ${label} 并加入额度管家（令牌会过期，到期会自动续）` }
      } catch (e) {
        return { ok: false, message: `登录失败：${e?.message ?? e}` }
      }
    }

    /** 从探测回答里挑一个账号名：new-api 令牌名、sub2api 的邮箱/用户名，都没有就用域名。 */
    function accountLabelFromProbe(probe, root) {
      const d = asRecord(probe.body)
      const data = asRecord(d?.data) ?? d ?? {}
      const user = asRecord(data.user) ?? data
      return String(user?.email ?? user?.username ?? user?.display_name ?? user?.name ?? "").trim() || siteLabel(root)
    }

    /**
     * 把额度整理成一张卡片。字段都是 magpie 自己的额度结构（plan/windows/
     * balance/until），排版和额度提醒交给 magpie。这里先读一次凭据，按它在
     * auth 文件里的 key 查 state.json 里用户给站点起的名字。
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
          "添加一个站点：action=add，给出 site 和 token（new-api 用 sk-… 令牌，sub2api 用 API 密钥或登录令牌）；" +
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
          ? `导入了 ${added.length} 个站点，打开 Settings → Usage 就能看到它们的额度。`
          : "没有可导入的站点（要么都导入过了，要么那些 provider 里没有带 key 的中转站）。",
      }
    }

    /** 把一个账号移出额度管家（只是不再读它的额度，站点上的账号不受影响）。 */
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
       * magpie 每次拼请求配置时都会叫一次。这里给额度管家安一个 provider 壳子：
       * 地址用 plugin:// 开头（magpie 认得，不会真去联网），名字显示成「额度管家」，
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

          if (magpieOption(OPTION_KEYS.showProviderScan) && Date.now() - lastProviderScanAt > PROVIDER_SCAN_INTERVAL) {
            lastProviderScanAt = Date.now()
            const sites = loadProviderSites(directory)
            const known = new Set(registeredSites(directory).map((s) => s.key))
            const fresh = sites.filter((s) => !known.has(s.key))
            if (fresh.length) {
              log(
                "info",
                `发现 ${fresh.length} 个还没加入额度管家的站点：${fresh
                  .slice(0, 8)
                  .map((s) => s.name)
                  .join("、")}${fresh.length > 8 ? " 等" : ""}。可以对 agent 说“把没导入的站点导入额度管家”。`,
              )
            }
          }
        }),

      auth: {
        provider: PROVIDER_ID,
        label: PROVIDER_NAME,
        // 仪表盘线稿图标（24×24、圆角端点），颜色在浅色和深色卡片上都够亮；
        // magpie 把它当图片画，不能用 currentColor
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTZhMzRhIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMuNSAxOGE4LjUgOC41IDAgMSAxIDE3IDAiLz48cGF0aCBkPSJtMTIgMTUgNC4yLTQuMiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTUiIHI9IjEuMyIgZmlsbD0iIzE2YTM0YSIgc3Ryb2tlPSJub25lIi8+PHBhdGggZD0iTTQuNSAxNGgyTTE3LjUgMTRoMk02LjYgOC42bDEuNCAxLjRNMTcuNCA4LjYgMTYgMTAiLz48L3N2Zz4=",
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
            label: "new-api 令牌（sk-…）",
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
                message: "令牌（站点 → 令牌 / 设置 → 访问令牌，sk-… 开头）",
                placeholder: "粘贴站点里建的令牌",
              },
              { type: "text", key: "name", message: "备注名（留空用域名）", placeholder: "可选" },
            ],
            async authorize(inputs = {}) {
              const site = siteRootOf(inputs.site)
              if (!site) return { type: "failed", error: "站点地址看不懂，请填完整网址" }
              const token = String(inputs.token ?? "").trim()
              if (!token) return { type: "failed", error: "没有填令牌" }
              // 用这把令牌读一次自己的额度：能读出来，就说明它可用。
              // 公开接口认不出站点类型也不打紧，凭据能读通就算数。
              const detected = await detectSite(site)
              const { kind: kindOf, probe } = await probeCredential(site, token, detected?.kind)
              if (probe.error) return { type: "failed", error: `${siteLabel(site)} 连不上：${probe.error}` }
              if (probe.rejected) {
                return {
                  type: "failed",
                  error:
                    `${siteLabel(site)} 不认这个凭据（HTTP ${probe.status}${probe.body ? ` · ${httpSummary(probe).split("：")[1] ?? ""}` : ""}）。` +
                    probe.hint,
                }
              }
              if (probe.unrecognized) {
                return { type: "failed", error: `${siteLabel(site)} 没有可用的额度接口（HTTP ${probe.status}）` }
              }
              const name = String(inputs.name ?? "").trim() || accountLabelFromProbe(probe, site)
              return {
                type: "success",
                key: token,
                accountId: name,
                metadata: { site, name, kind: kindOf, source: "manual" },
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
              const detected = await detectSite(site)
              const probe = await probeToken(site, "sub2api", token)
              if (probe.error) return { type: "failed", error: `${siteLabel(site)} 连不上：${probe.error}` }
              if (probe.rejected) {
                return { type: "failed", error: `${siteLabel(site)} 不认这个凭据（HTTP ${probe.status}）。${probe.hint}` }
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

        /** magpie 每次用到账号前会问一次；额度管家不需要额外准备什么。 */
        async loader() {
          return {}
        },

        usage: (getAuth) => safety("读额度", () => usageCard(getAuth)),
      },

      tool: {
        manage_usage: {
          description:
            "额度管家：列出/导入 magpie 里配置的中转站（new-api、sub2api），把它们的额度读进 Usage 卡片。" +
            "action=providers 列出站点与账号；action=import 一键导入 providers.json 里的站点；" +
            "action=add 添加一个站点（site、token 或 email/password）；action=remove 移除一个账号。",
          args: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["providers", "import", "add", "remove"] },
              site: { type: "string", description: "站点地址，例如 https://example.com" },
              token: { type: "string", description: "站点凭据：new-api 的 sk-… 令牌 / sub2api 的 API 密钥或 access token" },
              email: { type: "string" },
              password: { type: "string" },
              name: { type: "string" },
              account: { type: "string", description: "要移除的账号名" },
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
              if (action === "remove") {
                const out = await removeAccount({ account: args.account })
                return { output: out.message ?? JSON.stringify(out, null, 2) }
              }
              return { output: "action 要是 providers / import / add / remove 之一" }
            } catch (e) {
              return { output: `这一步没做成：${e?.message ?? e}` }
            }
          },
        },
      },
    }
  },
}
