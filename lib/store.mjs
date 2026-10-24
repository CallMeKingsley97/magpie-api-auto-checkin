// 站点与账号的登记簿。
//
// 只读 magpie 的 providers.json / plugin-providers.json，从中挑出用户已经
// 配置过的站点；额度管家自己的账号状态写在自己目录下的 state.json 里。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { asRecord, siteRootOf, readState, writeState } from "./core.mjs"

export const PLUGIN_ID = "quota-manager"

// provider 配置里可能出现的地址字段。website 最接近站点主页，优先用；
// 其余字段通常是 API 地址，siteRootOf 会去掉 /v1、/v1beta 之类的后缀。
export const SITE_FIELDS = [
  "website",
  "site",
  "baseUrl",
  "baseURL",
  "base_url",
  "responses",
  "chat",
  "anthropic",
  "gemini",
  "apiBase",
  "api_base",
  "apiUrl",
  "api_url",
  "endpoint",
  "url",
]

export function readJsonFile(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"))
    return v
  } catch {
    return undefined
  }
}

/** 从一条 provider 配置里挑一个能代表站点的地址。 */
export function siteOfProvider(provider) {
  const p = asRecord(provider)
  if (!p) return ""
  for (const field of SITE_FIELDS) {
    const value = p[field]
    if (typeof value !== "string" || !value.trim()) continue
    const root = siteRootOf(value)
    if (root) return root
  }
  return ""
}

/** 判断两个地址是不是同一个站点：忽略大小写、协议以外的尾斜杠。 */
export function siteKey(url) {
  const root = siteRootOf(url)
  if (!root) return ""
  try {
    const u = new URL(root)
    return (u.host + u.pathname.replace(/\/+$/, "")).toLowerCase()
  } catch {
    return ""
  }
}

// ---- 读取 magpie 现有 provider ---------------------------------------------

/** 把几种可能的文件形状都摊平成 provider 数组。 */
function providerArray(data) {
  const d = asRecord(data) ?? {}
  if (Array.isArray(data)) return data
  if (Array.isArray(d.providers)) return d.providers
  if (Array.isArray(d.plugins)) return d.plugins
  if (Array.isArray(d.items)) return d.items
  // { "<id>": {...}, ... }
  const entries = Object.entries(d).filter(([, v]) => asRecord(v))
  if (entries.length && !("version" in d) && !("providers" in d)) {
    return entries.map(([id, v]) => ({ id, ...asRecord(v) }))
  }
  return []
}

/**
 * 用户已经配置过的站点清单。
 * 返回 [{ key, site, name, source, providerIds, hasKey }]，按站点去重。
 */
export function loadProviderSites(directory) {
  const sites = new Map()
  for (const [file, source] of [
    ["providers.json", "provider"],
    ["plugin-providers.json", "plugin"],
  ]) {
    const data = readJsonFile(path.join(directory, file))
    for (const item of providerArray(data)) {
      const p = asRecord(item)
      if (!p) continue
      const id = String(p.id ?? p.name ?? "")
      // 额度管家自己的 provider 不算“用户已有站点”
      if (!id || id === PLUGIN_ID || id.startsWith(PLUGIN_ID + "#")) continue
      const site = siteOfProvider(p)
      const key = siteKey(site)
      if (!site || !key) continue
      const prev = sites.get(key)
      if (prev) {
        if (!prev.providerIds.includes(id)) prev.providerIds.push(id)
        continue
      }
      sites.set(key, {
        key,
        site,
        name: String(p.name ?? p.id ?? site),
        source,
        providerIds: [id],
        hasKey: typeof p.key === "string" && p.key.length > 0,
      })
    }
  }
  return [...sites.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 额度管家已经登记过的站点（来自 state.json 的账号索引）。 */
export function registeredSites(directory) {
  const state = readState(directory)
  const accounts = asRecord(state.accounts) ?? {}
  const out = new Map()
  for (const [accountId, raw] of Object.entries(accounts)) {
    const a = asRecord(raw)
    if (!a) continue
    const site = String(a.site ?? "")
    const key = siteKey(site)
    if (!key) continue
    const prev = out.get(key)
    if (prev) {
      prev.accountIds.push(accountId)
      continue
    }
    out.set(key, {
      key,
      site,
      accountId,
      accountIds: [accountId],
      name: String(a.name ?? accountId),
      kind: String(a.kind ?? ""),
    })
  }
  return [...out.values()]
}

/**
 * providers.json 里存在、但还没加入额度管家的站点。
 * known 参数可以传 registeredSites() 的结果，省一次读盘。
 */
export function unregisteredSites(directory, known = registeredSites(directory)) {
  const knownKeys = new Set(known.map((s) => s.key))
  return loadProviderSites(directory).filter((s) => !knownKeys.has(s.key))
}

// ---- 账号状态 ---------------------------------------------------------------

export function loadState(directory) {
  const state = readState(directory)
  return {
    version: 1,
    ...state,
    accounts: asRecord(state.accounts) ?? {},
  }
}

export function getAccountState(directory, accountId) {
  return asRecord(loadState(directory).accounts[accountId]) ?? {}
}

export function patchAccountState(directory, accountId, patch) {
  if (!accountId) return
  const state = loadState(directory)
  state.version = 1
  state.accounts[accountId] = {
    ...(asRecord(state.accounts[accountId]) ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  writeState(directory, state)
  return state.accounts[accountId]
}

// ---- 直接往 plugin-auth.json 里加账号 ---------------------------------------
//
// 走 magpie 的登录流程（authorize）时，账号由插件进程按作用域自己存好，这里
// 不用管。但“一键导入”和“添加站点”不在登录流程里：那时 client.auth.set 会
// 写到 provider 自己那一个 key 上，第二个站点就会把第一个覆盖掉。所以这两条
// 路直接写文件，用跟 host 一样的锁和原子写，免得把别人正在写的账号冲掉。

const AUTH_LOCK_STALE = 10_000

function lockFile(file) {
  const lock = file + ".lock"
  for (let i = 0; i < 400; i++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600))
      return () => {
        try {
          fs.unlinkSync(lock)
        } catch {}
      }
    } catch {}
    let stale = false
    try {
      stale = Date.now() - fs.statSync(lock).mtimeMs > AUTH_LOCK_STALE
    } catch {}
    if (stale) {
      try {
        fs.unlinkSync(lock)
      } catch {}
    }
    // 同步地等一小会儿（host 写文件时也是同步的，这里不能 await）
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    } catch {}
  }
  return () => {}
}

function writeDurable(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    const buf = Buffer.from(data)
    const f = fs.openSync(tmp, "w", 0o600)
    try {
      for (let off = 0; off < buf.length; ) off += fs.writeSync(f, buf, off, buf.length - off)
      try {
        fs.fsyncSync(f)
      } catch {}
    } finally {
      fs.closeSync(f)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw e
  }
}

/** plugin-auth.json 的路径。 */
export function authFilePath(directory) {
  const base = directory || path.join(os.homedir(), ".config", "magpie")
  return path.join(base, "plugin-auth.json")
}

/**
 * 把一个账号写进 plugin-auth.json，只动这一个 key。
 * 返回 true 表示写好了；文件读不出来时返回 false，不动任何东西。
 */
export function putAuthAccount(directory, key, body) {
  if (!key) return false
  const file = authFilePath(directory)
  const existed = fs.existsSync(file)
  const unlock = lockFile(file)
  try {
    let all = {}
    if (existed) {
      try {
        all = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        return false // 读不出来就别写，免得把别人的登录态写没了
      }
      if (!asRecord(all)) return false
    }
    all[key] = body
    if (existed) {
      try {
        fs.copyFileSync(file, file + ".bak")
      } catch {}
    }
    writeDurable(file, JSON.stringify(all, null, 2) + "\n")
    return true
  } catch {
    return false
  } finally {
    unlock()
  }
}

/**
 * 一条账号是不是本插件认得出的账号：要有站点和站点类型。
 * 只用来决定“哪个名字能当第一个账号”，以及展示时跳过读不懂的条目；
 * 不认识的条目原样留着，别的流程（或者用户）可能还需要它。
 */
export function isPluginAccountShape(raw) {
  const b = asRecord(raw)
  if (!b) return false
  const meta = asRecord(b.metadata) ?? {}
  const site = String(meta.site ?? b.site ?? "").trim()
  const kind = String(meta.kind ?? b.kind ?? "").trim()
  return !!(site && kind)
}

/** 从 plugin-auth.json 里去掉一个账号。 */
export function dropAuthAccount(directory, key) {
  if (!key) return false
  const file = authFilePath(directory)
  if (!fs.existsSync(file)) return false
  const unlock = lockFile(file)
  try {
    let all
    try {
      all = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      return false
    }
    if (!asRecord(all) || !(key in all)) return false
    delete all[key]
    // 删完之后如果本插件一条“认得出来”的账号都不剩了，就把剩下的读不懂的
    // 条目（旧版本留下的半个账号之类）也清掉：它们签不了到，只会占着列表。
    const rest = Object.keys(all).filter((k) => k === PLUGIN_ID || k.startsWith(PLUGIN_ID + "#"))
    if (rest.length && !rest.some((k) => isPluginAccountShape(all[k]))) {
      for (const k of rest) delete all[k]
    }
    try {
      fs.copyFileSync(file, file + ".bak")
    } catch {}
    writeDurable(file, JSON.stringify(all, null, 2) + "\n")
    return true
  } catch {
    return false
  } finally {
    unlock()
  }
}
