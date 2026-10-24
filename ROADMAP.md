# 路线图

Step 1 已经做完：签到全部拆掉，Usage 卡片改成 magpie 的结构化额度字段
（`plan` / `user` / `balance` / `windows[]` / `until` / `renew` / `error` /
`signIn`），额度提醒随卡片字段自动生效。

下面是按性价比排下来的下一步，写成可执行的形状，免得下次从零想起。

---

## 3. 模型清单漂移检测

### 要解决什么

magpie 的 `providers.json` 里，每条 provider 都有一个 `models` 字段（模型 id
列表）；网关 `/v1/models` 才是站点**此刻**真正提供的模型。两者会漂移：

- 站点上新了模型，magpie 里还没有 → 用不了；
- 站点下线了某个模型，magpie 里还留着 → 路由到它就会报错；
- 站点改了模型的实际名称/上下文长度。

实测（本机 108 个账号的探测）：29 个 new-api 站点里 **22 个**的
`providers.json` 模型清单和 `/v1/models` 不一致，值得做。

### 数据从哪来

| 来源 | 接口 | 说明 |
| --- | --- | --- |
| magpie 本地 | `providers.json` → `providers[].models` | 用户当前用的清单 |
| 站点 | `GET /v1/models`（OpenAI 兼容，`Authorization: Bearer <key>`） | 需要那把 provider 的 key |

`/v1/models` 的回答形状：`{ object: "list", data: [{ id, object: "model", created, owned_by }] }`。
new-api / sub2api 都实现了这个接口。

只需读 `data[].id`，不读模型详情，也不发任何请求到模型本身。

### 怎么呈现

**不自动改 providers.json。** 漂移是信息，不是错误；静默改用户的配置是最糟的
做法（用户可能故意只留一部分模型）。做法是：

1. 新增一个只读检查：`magpie-quota-manager_manage_usage` 加
   `action=drift`，输出每个站点的三组差异：
   - `missing`：站点有、magpie 里没有（值得加）
   - `stale`：magpie 里有、站点没有（路由过去会失败）
   - `same`：两边一致（只计数，不逐条列）
2. 结果缓存到 `state.json` 的 `drift` 字段（按站点 + 读到的模型 id 的哈希），
   Usage 卡片**不显示**，只在 agent 问起时给。
3. 用户明确要求时，`action=drift&apply=true` 才把 `missing` 写进
   `providers.json` 对应 provider 的 `models`（写前备份 `providers.json.bak`，
   只增不删；`stale` 永不自动删）。

### 要小心的地方

- **`/v1/models` 可能要求不同的 key**：new-api 用 sk-… 令牌能读；个别站点
  只允许带 `models` 权限的令牌。401 时如实报，不回落成「站点没模型」。
- **模型 id 有大小写和别名**：比较时统一小写，`gpt-4o` 和 `gpt-4o-2024-08-06`
  是两个 id，不做模糊匹配（magpie 自己也按 id 精确匹配）。
- **别在 usage 钩子里做**：`/v1/models` 的响应可能几百 KB，放进每次卡片刷新
  会拖慢 Usage 页。只在 `action=drift` 里按需读。
- **限流**：几十个站点串行读，每个之间留 ~300ms；遇到 429 用现成的
  `noteRateLimit` 退避，跳过这个站点继续下一个。

### 验收

- 对一个故意缺模型的测试站点，`action=drift` 输出 `missing` 里有它；
- 对一个故意多模型的测试站点，`stale` 里有它；
- `apply=true` 只往 `models` 里加，不删任何现有 id；
- 401 站点单独列出，不混进 `stale`。

---

## 4. 站点公告汇总

### 要解决什么

new-api 和 sub2api 的站点首页都有公告（维护通知、涨价、活动）。用户有几十个
中转站，没人会挨个点开看。把这些公告收进一处，按时间倒序，一眼扫完。

实测：`/api/status` 是公开接口，不需要任何凭据，约 **29 个**站点能读到。

### 数据从哪来

| 站点类型 | 接口 | 字段 |
| --- | --- | --- |
| new-api | `GET /api/status` | `data.announcements`（仅在 `announcements_enabled` 为真时出现）；`data.faq` 同理 |
| sub2api | `GET /api/v1/settings/public` | 站点设置里带公告/通知字段 |

new-api 的 `announcements` 是数组，元素一般形如
`{ id, content, publishDate, type, extra }`（`type` 是 `default` / `ongoing` /
`success` / `warning` / `error`；`content` 是 Markdown 或 HTML）。**读之前先
看 `announcements_enabled`**：为假时字段根本不存在，别当成「没有公告」。

### 怎么呈现

不动 Usage 卡片（那里只放额度）。做成一个 artifact + 一个工具：

1. `action=announcements`（工具）：拉所有已导入站点的公告，输出纯文本摘要
   ——站点名、发布时间、标题（`content` 的第一行去掉 Markdown 标记）。
2. 摘要写到 state 目录下的 `announcements.json`，同时生成一份 Markdown
   artifact，用户可以在 magpie 里直接打开看。
3. 已读标记：用户看过的公告按 `站点|公告id|publishDate` 记下来，下次只提示
   新的（和 magpie 的 `usage-alerts.json` 一个思路）。

### 要小心的地方

- **HTML/Markdown 不直接渲染**：只取纯文本摘要，避免把站点的脚本带进来。
  `extra` 字段里可能藏着链接，只保留 `http(s)` 的。
- **公告可能是站长的营销内容**，不是技术通知：这就是为什么只做「汇总 + 新的
  提示」，不做推送、不发系统通知。
- **`/api/status` 有的站点 404 或超时**：如实记成「读不到」，别让一个坏站点
  挡住整批。并行读，每个 8 秒超时，失败只跳过。
- **不需要任何密钥**：这正是它的性价比所在。但公共网络请求也要尊重退避。

### 验收

- 对一个 fixtures 站点，输出里有它的公告标题和日期；
- `announcements_enabled=false` 的站点不出现在结果里，也不算失败；
- 一条公告只提示一次；
- 一个站点超时不拖慢其它站点（并发读）。

---

## 已排除的方向（记下来免得重想）

- **签到**：需要导入站点登录凭证，new-api 只能人工建令牌，sub2api 常常没有
  签到功能；维护成本远大于收益。Step 1 已全部拆除。
- **`GET /api/user/self`**：要登录态，sk-… 令牌一律 401（108 个账号实测 0 成功）。
- **`GET /api/log/token`**：没有分页，只能拿最近几条，做不了趋势。
- **充值、兑换码、改配置**：写操作，插件不该碰。
