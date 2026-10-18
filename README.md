# 签到管家（Auto Check-in）

magpie 插件：把你在 magpie 里配置过的 new-api / sub2api 中转站每天自动签到一遍。
一个账号 = 一个站点，签不了的会逐条说清原因。

## 装

```sh
magpie plugin add github:CallMeKingsley97/magpie-plugins
```

或者把仓库克隆下来，用本地路径装：

```sh
magpie plugin add /path/to/magpie-plugins
```

装好后在 magpie 的 Providers 里会多出一个「签到管家」，每个站点的账号都挂在它下面。

## 用

### 1. 一键导入（推荐先做）

你已经在 magpie 里配过的站点，凭据（那条 provider 的 key）直接拿来用：

> 对 agent 说：“把没导入的站点导入签到管家”，或者让它调用 `auto-checkin_manage_checkin`，`action=import`。

导入时会顺手认站点类型：能认出来的会记下是 new-api 还是 sub2api；认不出来的也会导进来，等第一次签到再认。

### 2. 手动加站点

Providers → 签到管家 → 「登录」里有三种方式：

| 方式 | 用到什么时候 |
| --- | --- |
| **new-api 访问令牌** | new-api 站点。去站点的「设置 → 访问令牌」建一个，这个令牌长期有效，签到不会失效 |
| **sub2api 邮箱密码** | sub2api 站点。插件会登录并把邮箱密码留在账号里，令牌过期时自动重新登录 |
| **sub2api 手动导入令牌** | 不想存密码时：从浏览器里复制登录后的 access token 填进来 |

### 3. 签到

装好后 magpie 会**每天自动**给每个账号签一次（按北京时间算日界）。手动触发：

```sh
magpie accounts checkin
```

或让 agent 调 `auto-checkin_manage_checkin`，`action=checkin`。结果在：

- Usage 卡片（每个账号显示站点、类型、余额、今天签没签、拿了多少）
- Settings → Usage → Plugins（默认关，打开后能看到每次签到结果）
- `magpie accounts checkin` 的输出

## 结果怎么看

每次签到都是这几种结果之一，说人话：

| 结果 | 意思 | 你要做什么 |
| --- | --- | --- |
| ✅ 签到成功 | 拿到了奖励 | 不用管 |
| ☑️ 今日已签到 | 今天早签过了，不重复领 | 不用管 |
| ⏸️ 没开启签到 | 站点管理员把签到功能关了 | 等站长开，或者不用管 |
| ⛔ 无资格 | 站点说这个账号暂时不能签（门槛没到、被封了之类） | 看提示里的原因 |
| 🛡️ 要人机验证 | 站点开了 Turnstile 之类，插件不破解验证码 | 到站点网页手动签一次 |
| ❌ 失败 | 见下面的具体原因 | 见下 |

失败的常见原因，插件会直接写清：

- **连不上**：站点挂了、域名解析不了、CDN 拦了
- **没适配**：这个站点不是 new-api/sub2api，或者签到接口没有见过
- **令牌失效**：new-api 去「设置 → 访问令牌」重新建一个；sub2api 重新登录
- **限流**：稍后自动重试

## 支持的站点

- **new-api**（及其分支）：`/api/status` + `/api/user/checkin`。认证用访问令牌（长期有效）。
- **sub2api**（及其分支）：登录 + 一批分支站的签到接口（Sub2API Pro、FreeAPI、Hiyo、ToolCode、Daigua、Genius Programmer、Clawhud、Sidrune、小白Code）。认不出的分支站会如实说“没适配”，不会乱试。

## 边界与隐私

- 只读 magpie 自己的配置文件（`providers.json`、`plugin-providers.json`、自己的 `plugin-auth.json`），请求**只发往你自己配置的那些站点**。
- 不破解任何人机验证；遇到 Turnstile 直接如实报 `captcha`。
- 日志和提示里不写密钥，不写完整响应体。
- sub2api 账号密码存在 magpie 的 `plugin-auth.json`（0600 权限）里，用于令牌过期时自动重新登录；不想存密码就用手动导入令牌的方式。

## 已知限制

- 签到日界按北京时间（Asia/Shanghai），站点用自己的时区的会略有出入。
- new-api 的「旧式令牌」如果被站点退役了，需要去站点建带 wallet 权限的新令牌。
- 站点开了人机验证的签到必须手动做一次，插件不做绕过。

## 开发

```sh
npm test        # node --test "tests/*.test.mjs"
```

代码结构：

- `index.mjs` — 插件入口：config / auth / tool 三个钩子
- `lib/core.mjs` — HTTP、报文解包、错误分类、本地状态文件
- `lib/store.mjs` — 站点清单、账号登记、签到历史
- `lib/checkin.mjs` — 认站点 + 各站点的签到实现
- `lib/usage.mjs` — Usage 卡片

## License

MIT
