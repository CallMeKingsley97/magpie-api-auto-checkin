# 签到管家（Auto Check-in）

magpie 插件：把你在 magpie 里配置过的 new-api / sub2api 中转站每天自动签到一遍。
一个账号 = 一个站点，签不了的会逐条说清原因。

## 装

```sh
magpie plugin add github:CallMeKingsley97/magpie-api-auto-checkin
```

或者把仓库克隆下来，用本地路径装：

```sh
magpie plugin add /path/to/magpie-api-auto-checkin
```

装好后在 magpie 的 Providers 里会多出一个「签到管家」，每个站点的账号都挂在它下面。

## 用

### 1. 一键导入（推荐先做）

你已经在 magpie 里配过的站点，凭据（那条 provider 的 key）直接拿来用：

> 对 agent 说：“把没导入的站点导入签到管家”，或者让它调用 `magpie-api-auto-checkin_manage_checkin`，`action=import`。

导入时会顺手认站点类型：能认出来的会记下是 new-api 还是 sub2api；认不出来的也会导进来，等第一次签到再认。

### 2. 手动加站点

Providers → 签到管家 → 「登录」里有三种方式：

| 方式 | 用到什么时候 |
| --- | --- |
| **new-api 访问令牌** | new-api 站点。去站点的「设置 → 访问令牌」建一个，这个令牌长期有效，签到不会失效 |
| **sub2api 邮箱密码** | sub2api 站点。插件会登录并把邮箱密码留在账号里，令牌过期时自动重新登录 |
| **sub2api 登录令牌** | 不想存密码时：从浏览器里复制登录后的 access token 填进来 |

### 3. 打开每日自动签到（重要）

magpie 对插件自己的签到**默认是关的**，要手动开一次，之后才会每天自动跑：

> Settings → Usage → 「Plugins」标签 → 找到「签到管家 · Daily check-in」→ 打开。

**这个开关只有在你至少加了一个站点之后才会出现。** magpie 在插件一个账号都没有时，
会把整个「Plugins」标签藏起来（`pluginCheckinProviders()` 要求 `len(accounts) > 0`），
所以「找不到签到管家」通常意味着还没加站点，不是插件没装上。

打开后 magpie 每天给每个账号签一次（按北京时间算日界）；当天失败的话，晚些还会再试一次。

不想开自动也行，随时手动签：

```sh
magpie accounts checkin
```

或让 agent 调 `magpie-api-auto-checkin_manage_checkin`，`action=checkin`。结果在：

- Usage 卡片（每个账号显示站点、类型、余额、今天签没签、拿了多少）
- Settings → Usage（每个账号最近一次签到结果）
- `magpie accounts checkin` 的输出

## 结果怎么看

每次签到都是这几种结果之一，说人话：

| 当天的签到结果 | 三种地方都看得到，说法一致 |
| --- | --- |
| Usage 卡片 | magpie 在账号卡片下面画一行：已签 / 已签 +N / 未开始 / 无资格 / 要验证码 / 失败（带原因） |
| Settings → Usage → Plugins | 每个账号最近一次签到结果 |
| `magpie accounts checkin` | 逐条打印，结尾一行汇总 |

卡片本身只放站点类型、账号和余额，不再把签到细节堆成一句话；签到结果交给 magpie 自己的签到行，两边不会重复，也不会互相矛盾。卡片右上角的「Auto check-in」开关就是每日自动签到，和 Settings → Usage 里那个是同一个。

## 结果怎么看

每次签到都是这几种结果之一，说人话：

| 结果 | 意思 | 你要做什么 |
| --- | --- | --- |
| 签到成功 | 拿到了奖励（magpie 会显示 +N） | 不用管 |
| 今日已签到 | 今天早签过了，不重复领 | 不用管 |
| 没开启签到 | 站点管理员把签到功能关了 | 等站长开，或者不用管 |
| 无资格 | 站点说这个账号暂时不能签（门槛没到、被封了之类） | 看提示里的原因 |
| 要人机验证 | 站点开了 Turnstile 之类，插件不破解验证码 | 到站点网页手动签一次 |
| 失败 | 见下面的具体原因 | 见下 |

失败的常见原因，插件会直接写清：

- **连不上**：站点挂了、域名解析不了、CDN 拦了
- **没适配**：这个站点不是 new-api/sub2api，或者签到接口没有见过
- **令牌失效**：new-api 去「设置 → 访问令牌」重新建一个；sub2api 重新登录
- **限流**：稍后自动重试

## 支持的站点

### new-api 及其分支

| 分支 | 签到接口 | 怎么认出来 |
| --- | --- | --- |
| **new-api**（官方） | `POST /api/user/checkin`，状态 `GET /api/user/checkin?month=YYYY-MM` | `/api/status` 里有 `checkin_enabled` |
| **Veloera** | `POST /api/user/check_in`，状态 `GET /api/user/check_in_status` | `/api/status` 里有 `check_in_enabled` |
| **Rix API** 等 | 同官方 | `/api/status` 里有 `enable_checkin` |
| **WONG 公益站** 等 | 同官方，状态里用 `checked_in` 表示今天签过 | 命中官方接口的报文形状 |

认证统一用访问令牌（长期有效）。

### sub2api 及其分支

登录方式都一样（`/api/v1/auth/login`），签到接口各有各的路径和字段：

| 分支 | 状态接口 | 签到接口 |
| --- | --- | --- |
| **Sub2API Pro** | `/api/v1/redeem/checkin/status` | `/api/v1/redeem/checkin` |
| **FreeAPI** | `/api/v1/user/checkin?timezone=…` | 同一路径 POST |
| **Hiyo** | `/api/v1/checkin?timezone=…` | `/api/v1/checkin` |
| **ToolCode** | `/api/v1/engagement/checkin/status` | `/api/v1/engagement/checkin` |
| **Daigua** | `/api/v1/checkin/status` | `/api/v1/checkin` |
| **Genius Programmer** | `/api/v1/user/checkin/status`（`today_checked_in`） | `/api/v1/user/checkin` |
| **Clawhud** | `/api/v1/user/checkin/status`（`checked_in_today`） | `/api/v1/user/checkin` |
| **Sidrune** | `/api/v1/welfare/profile` | `/api/v1/welfare/checkin` |
| **Denxio** | `/api/v1/tbe-sponsor-checkin/status` | `normal/begin` → 等待 → `normal/claim`（两段式） |
| **AI-ROUTER** | `/api/v1/user/daily-checkin?timezone=…` | 同一路径 POST |
| **小白Code** | `/checkin/api/status` | `/checkin/api/checkin` |

几个容易搞错的地方，插件都按协议处理了：

- **Genius Programmer 和 Clawhud 共用状态路径**，字段名只差一个（`today_checked_in` / `checked_in_today`）。插件按完整报文指纹区分，不会把一家的签到发到另一家的接口上。
- **重复签到优先看 `reason` 码**（`DAILY_CHECKIN_ALREADY_DONE`、`CHECKIN_ALREADY_DONE`、`CHECKIN_ALREADY_COMPLETED`、`DAILY_CHECKIN_CLAIMED` 等），不依赖站点自定义的中文文案。
- **“管理员关了”“今天不能签”“没资格”分开报**：`admin_disabled` / `DAILY_CHECKIN_DISABLED` 是管理员关；`eligible=false`、`tokens_met=false`、`can_checkin=false` 是账号或这一轮的条件不够；只有站点的每日开关真的关了才说“没开启签到”。
- **POST 请求体按站点原生行为发**：Hiyo / Daigua / 小白Code 发空对象 `{}`，其余分支裸 POST（不带 body）。
- **失败后会回读一次状态**：请求到了但响应丢了的情况，如实报“今日已签到”，不制造一次假失败。

认不出的分支站会如实说“没适配”，不会乱试。

## 边界与隐私

- 只读 magpie 自己的配置文件（`providers.json`、`plugin-providers.json`、自己的 `plugin-auth.json`），请求**只发往你自己配置的那些站点**。
- 不破解任何人机验证；遇到 Turnstile 直接如实报 `captcha`。
- 日志和提示里不写密钥，不写完整响应体。
- sub2api 账号密码存在 magpie 的 `plugin-auth.json`（0600 权限）里，用于令牌过期时自动重新登录；不想存密码就用手动导入令牌的方式。

## 已知限制

- **每日自动签到默认是关的**，要在 Settings → Usage 里给「签到管家」打开（见上）。
- **Settings → Usage 里看不到「Plugins」标签，是因为还没有账号。** 先加一个站点，标签才会出现。
- 签到日界按北京时间（Asia/Shanghai），站点用自己的时区的会略有出入。
- new-api 的「旧式令牌」如果被站点退役了，需要去站点建带 wallet 权限的新令牌。
- 站点开了人机验证的签到必须手动做一次，插件不做绕过。
- 一个站点记一个账号。同一个站点想签多个账号，暂时得分开装一份插件。

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
