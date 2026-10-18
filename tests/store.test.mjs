// 站点清单的读取与本地状态文件。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLUGIN_ID, authFilePath, checkedToday, dropAuthAccount, isPluginAccountShape, loadProviderSites, patchAccountState, putAuthAccount, recordResult, registeredSites, unregisteredSites } from "../lib/store.mjs"
import { siteKeyOf, siteRootOf } from "../lib/core.mjs"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auto-checkin-"))
}

test("站点地址归一化：去掉 /v1、/v1beta、末尾斜杠", () => {
  assert.equal(siteRootOf("https://a.example.com/v1/"), "https://a.example.com")
  assert.equal(siteRootOf("https://a.example.com/v1beta"), "https://a.example.com")
  assert.equal(siteRootOf("https://a.example.com/openai/v1"), "https://a.example.com/openai")
  assert.equal(siteRootOf("不是网址"), "")
})

test("同一个站点写两种地址，算同一个站点", () => {
  assert.equal(siteKeyOf("https://A.example.com/v1"), siteKeyOf("https://a.example.com/"))
  assert.equal(siteKeyOf("https://a.example.com/v1beta"), siteKeyOf("https://a.example.com"))
  assert.notEqual(siteKeyOf("https://a.example.com"), siteKeyOf("https://b.example.com"))
})

test("读 providers.json：去重、跳过没地址的和签到管家自己", () => {
  const dir = tempDir()
  fs.writeFileSync(
    path.join(dir, "providers.json"),
    JSON.stringify({
      providers: [
        { id: "glm", name: "GLM", key: "sk-1", anthropic: "https://new-api.abrdns.com", website: "https://new-api.abrdns.com" },
        { id: "lucky", name: "Lucky", key: "sk-2", responses: "https://new.lucky0625.qzz.io/v1", website: "https://new.lucky0625.qzz.io" },
        { id: "no-url", name: "没有地址的", key: "sk-3" },
        { id: PLUGIN_ID, name: "签到管家", key: "x" },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(dir, "plugin-providers.json"),
    JSON.stringify({ providers: [{ id: "other", name: "别的插件", key: "sk-4", website: "https://other.example.com" }] }),
  )
  const sites = loadProviderSites(dir)
  const hosts = sites.map((s) => s.site).sort()
  assert.deepEqual(hosts, ["https://new-api.abrdns.com", "https://new.lucky0625.qzz.io", "https://other.example.com"])
  const glm = sites.find((s) => s.site.includes("abrdns"))
  assert.equal(glm.hasKey, true)
  assert.equal(glm.source, "provider")
})

test("登记过的站点记在 state.json 里，导入过的就不再算“没导入”", () => {
  const dir = tempDir()
  fs.writeFileSync(
    path.join(dir, "providers.json"),
    JSON.stringify({
      providers: [
        { id: "a", name: "A 站", key: "sk-a", website: "https://a.example.com" },
        { id: "b", name: "B 站", key: "sk-b", website: "https://b.example.com" },
      ],
    }),
  )
  patchAccountState(dir, PLUGIN_ID, { site: "https://a.example.com", name: "A 站", kind: "new-api" })
  const known = registeredSites(dir)
  assert.equal(known.length, 1)
  assert.equal(known[0].kind, "new-api")
  const rest = unregisteredSites(dir)
  assert.equal(rest.length, 1)
  assert.match(rest[0].site, /b\.example\.com/)
})

test("签到结果与“今天签过没有”都记在 state.json 里（有备胎文件可从损坏中恢复）", () => {
  const dir = tempDir()
  recordResult(dir, PLUGIN_ID, { outcome: "claimed", credit: 2300, message: "签到成功" })
  assert.equal(checkedToday(dir, PLUGIN_ID), true)

  // 把主文件写坏：应该从 .bak 里读回上一次的完整内容
  const p = path.join(dir, "auto-checkin", "state.json")
  fs.writeFileSync(p, "{ 坏掉的 JSON")
  recordResult(dir, PLUGIN_ID, { outcome: "failed", message: "站点挂了" })
  assert.equal(checkedToday(dir, PLUGIN_ID), false)

  const state = JSON.parse(fs.readFileSync(p, "utf8"))
  assert.equal(state.accounts[PLUGIN_ID].last.outcome, "failed")
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
})

test("别人写过的 state.json 不会丢：只更新自己那个账号", () => {
  const dir = tempDir()
  patchAccountState(dir, "other-plugin", { site: "https://x.example.com" })
  patchAccountState(dir, PLUGIN_ID, { site: "https://a.example.com" })
  const state = JSON.parse(fs.readFileSync(path.join(dir, "auto-checkin", "state.json"), "utf8"))
  assert.equal(state.accounts["other-plugin"].site, "https://x.example.com")
  assert.equal(state.accounts[PLUGIN_ID].site, "https://a.example.com")
})

test("往 plugin-auth.json 加账号：不动别人的 key，也不覆盖同一个站点的旧账号", () => {
  const dir = tempDir()
  const file = authFilePath(dir)
  fs.writeFileSync(file, JSON.stringify({ "other-plugin": { type: "api", key: "sk-other" } }))

  assert.equal(putAuthAccount(dir, PLUGIN_ID, { type: "api", key: "sk-a", accountId: "A 站", metadata: { site: "https://a.example.com", kind: "new-api" } }), true)
  assert.equal(putAuthAccount(dir, "auto-checkin#abc123", { type: "api", key: "sk-b", accountId: "B 站", metadata: { site: "https://b.example.com", kind: "new-api" } }), true)

  const all = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(all["other-plugin"].key, "sk-other")
  assert.equal(all[PLUGIN_ID].key, "sk-a")
  assert.equal(all["auto-checkin#abc123"].accountId, "B 站")
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  // 改之前会留一份 .bak
  assert.equal(JSON.parse(fs.readFileSync(file + ".bak", "utf8"))[PLUGIN_ID].key, "sk-a")

  // 移除一个：其它账号原样保留
  assert.equal(dropAuthAccount(dir, PLUGIN_ID), true)
  const after = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(after[PLUGIN_ID], undefined)
  assert.equal(after["auto-checkin#abc123"].key, "sk-b")
  assert.equal(after["other-plugin"].key, "sk-other")

  // 不在里面的 key：返回 false，文件不动
  assert.equal(dropAuthAccount(dir, "auto-checkin#nope"), false)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), ["auto-checkin#abc123", "other-plugin"])
})

test("plugin-auth.json 读不出来时，宁可写不进去也不覆盖", () => {
  const dir = tempDir()
  const file = authFilePath(dir)
  fs.writeFileSync(file, "{ 半截的 JSON")
  assert.equal(putAuthAccount(dir, PLUGIN_ID, { type: "api", key: "sk-a" }), false)
  assert.equal(fs.readFileSync(file, "utf8"), "{ 半截的 JSON")
})

test("认得出哪些账号是完好的，残缺的不会被当成账号（也不去删它）", () => {
  const dir = tempDir()
  const file = authFilePath(dir)
  assert.equal(isPluginAccountShape({ type: "api", key: "x" }), false)
  assert.equal(isPluginAccountShape({ metadata: { site: "https://a.example.com", kind: "new-api" } }), true)

  // 别人写进去、本插件读不懂的条目：原样保留
  fs.writeFileSync(file, JSON.stringify({ "other-plugin": { type: "oauth", refresh: "r" } }))
  putAuthAccount(dir, PLUGIN_ID, { type: "api", key: "sk-a", accountId: "A", metadata: { site: "https://a.example.com", kind: "new-api" } })
  const all = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(all["other-plugin"].refresh, "r")
  assert.equal(all[PLUGIN_ID].key, "sk-a")
})
