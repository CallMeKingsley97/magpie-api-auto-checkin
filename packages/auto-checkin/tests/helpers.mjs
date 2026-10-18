// 假的 fetch：给测试用，按 URL 匹配返回预设响应，并记录所有请求。
//
// 用法：const f = fakeFetch([{ match: "/api/status", body: {...} }])

export function fakeFetch(routes, { onRequest } = {}) {
  const calls = []
  const handler = async (url, init = {}) => {
    const href = String(url)
    calls.push({
      url: href,
      path: href.replace(/^https?:\/\/[^/]+/, ""),
      method: String(init.method ?? "GET").toUpperCase(),
      headers: init.headers ?? {},
      body: init.body,
    })
    onRequest?.({ url: href, init })
    for (const r of routes) {
      const matched =
        typeof r.match === "function"
          ? r.match(href, init)
          : r.match instanceof RegExp
            ? r.match.test(href)
            : href.includes(r.match)
      if (!matched) continue
      const hit = typeof r.respond === "function" ? r.respond({ url: href, init }) : r
      if (hit === undefined || hit === null) continue
      if (hit.error) throw Object.assign(new Error(hit.error), { code: hit.code })
      if (hit.timeout) {
        const e = new Error("The operation was aborted")
        e.name = "AbortError"
        throw e
      }
      return new Response(hit.text ?? JSON.stringify(hit.body ?? {}), {
        status: hit.status ?? 200,
        headers: { "Content-Type": "application/json", ...(hit.headers ?? {}) },
      })
    }
    return new Response(JSON.stringify({ error: "no route" }), { status: 404, headers: { "Content-Type": "application/json" } })
  }
  handler.calls = calls
  return handler
}

/** 某个路径被请求过几次。 */
export function countCalls(fetchImpl, path) {
  return (fetchImpl.calls ?? []).filter((c) => c.path.startsWith(path)).length
}

/** 某个路径最后一次请求的 body（JSON 解析好）。 */
export function lastBody(fetchImpl, path) {
  const hit = [...(fetchImpl.calls ?? [])].reverse().find((c) => c.path.startsWith(path))
  if (!hit) return undefined
  try {
    return JSON.parse(hit.body)
  } catch {
    return hit.body
  }
}
