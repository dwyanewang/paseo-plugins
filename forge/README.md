# Forge HTTP 插件

在一个 Paseo 插件内，通过个人访问令牌连接 **Codeup OpenAPI** 和 **Gitee API v5**。
所有平台请求直接使用 HTTP；没有 `aliyun`、`gh`、`glab` 等平台 CLI 依赖。
本地 Git 仅用于读取工作区 `origin`，检出、推送和工作树仍由 Paseo 宿主管理。

## 宿主要求

需要已构建的 `feat/plugin-host-infrastructure`，开发验证基于 `cb7765a3b`。
虽然该分支版本仍为 `0.8.0`，公开发布的原版 `0.8.0` 并不包含全部接口。
清单中的 `>=0.8.0` 是版本下限，还需要以下分支能力同时存在于 daemon 和 app：

- `addForgeServerProvider`、`addForgeClientProvider` 和 Forge 原生界面。
- `@getpaseo/plugin/server/forge-toolkit` 的 HTTP 客户端、分页保护和 Git remote 解析。
- `server.registerSettings(...).read()`、`server.secrets`。
- `setup.screenId` 和插件设置页。

无需修改宿主源码。先按照宿主仓库的流程构建 protocol、client、plugin 和 server 包。

## 开发与验证

默认 `file:` 依赖指向 `../../paseo`。宿主分支位于其他 worktree 时，只重连本插件的 SDK：

```bash
cd /path/to/paseo-plugins/forge
npm install --ignore-scripts --package-lock=false --legacy-peer-deps
npm run link:sdk -- /path/to/paseo-host-checkout
npm run typecheck
npm test
npm run check:host
```

`link:sdk` 会先验证已构建 SDK，再更新本目录 `node_modules/@getpaseo/*` 的符号链接；
不会改动其他插件或宿主工作树。重新 `npm install` 后，如开发 worktree 不同于默认路径，需要再次运行。
Zod 固定为 `4.4.3`，与该宿主分支一致，避免不同版本的类型定义产生冲突。

`check:host` 使用 SDK 所在 worktree 的真实插件编译器及子进程运行时，验证双提供者注册、
设置 CAS、密钥持久化、认证错误、停止和重新加载。数据写入临时目录，结束后删除；
不会连接日常 daemon、读取真实令牌或调用平台写接口。

## 安装和配置

在具备上述接口的宿主上安装：

```bash
paseo plugin install /absolute/path/to/paseo-plugins/forge
paseo plugin ls
```

在 **设置 → 插件 → forge → Forge 连接**，或命令中心“配置 Forge 连接”中配置：

| 平台   | 默认 API 地址                      | 默认 Git 域名       | 认证                                                        |
| ------ | ---------------------------------- | ------------------- | ----------------------------------------------------------- |
| Codeup | `https://openapi-rdc.aliyuncs.com` | `codeup.aliyun.com` | 云效个人访问令牌，使用 `x-yunxiao-token` 请求头             |
| Gitee  | `https://gitee.com/api/v5`         | `gitee.com`         | Gitee 个人访问令牌，使用 API 文档指定的 `access_token` 参数 |

每个平台保存一枚令牌。使用具备相应仓库读权限的令牌；创建和合并还需要相应写权限。
“测试连接”只读取当前用户信息，不创建或合并请求。
Codeup 的测试接口是 `GET /oapi/v1/platform/user`，令牌还需要该用户信息接口的读取权限；
仅授予代码仓库权限可能返回 `403 Forbidden: Current token has no permission to api.`。
遇到此错误，请在云效个人访问令牌的“组织管理”中补充“获取当前用户信息”对应的读取权限，
如需新建令牌，将新令牌保存到插件后再测试；无需授予全部 API 权限。
测试成功只说明可以读取当前用户，不代表具有每个仓库的读写权限。

Codeup 支持中心站和 Region 站：中心站的组织 ID 默认取 remote 路径第一段，也可手动指定；
Region 站省略组织层级。Git 域名可配置多个，用英文逗号分隔，也可以显式添加 SSH 别名。
API 地址可包含部署前缀，Gitee 地址需要包含 `/api/v5`，Codeup 地址不包含 `/oapi/v1`。
云效版本必须与 API 地址对应：`https://openapi-rdc.aliyuncs.com` 使用中心站；
Region 站使用组织实例的访问域名，不能只切换版本而继续使用中心站 API 地址。

令牌通过专用写入 RPC 存入 `server.secrets`，不进入设置文档，也没有读取令牌的客户端 RPC。
令牌绑定平台和完整 API 根地址；修改 API 地址后需要重新输入令牌。旧地址的令牌仍保留在
宿主密钥存储中，可切回旧地址后移除。请求拒绝重定向，并对错误中的令牌值做脱敏。

Codeup 不声明固定的云端域名：只有 remote 域名属于已配置的 Git 域名、且已保存令牌时才识别仓库。
保存设置或令牌后，请重新加载插件，以立即刷新宿主的 Forge 识别缓存：

```bash
paseo plugin reload forge
paseo plugin ls
```

## 功能范围

| 功能                                            | Codeup                                                 | Gitee                                                           |
| ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| PR/MR 列表、标题搜索、按 `!7` / `#7` / `7` 查询 | 支持                                                   | 支持；标题和正文搜索由插件分页过滤                              |
| 当前分支的请求状态与合并门禁                    | 支持                                                   | 支持                                                            |
| 创建、merge / squash / rebase 合并              | 支持                                                   | 支持                                                            |
| 源分支及跨仓库检出                              | 支持                                                   | 支持                                                            |
| 评论、行内评论                                  | 支持，包含回复与已解决评论                             | 支持                                                            |
| 评审状态                                        | 支持，并显示评审时间线                                 | 支持审批人状态；时间线展示 API 评论                             |
| CI/检查信息                                     | 展示合并门禁、冲突及已返回的卡点；CI 作业日志需打开 MR | 展示 check runs、详情和注释                                     |
| 自动合并                                        | 不提供                                                 | 不提供                                                          |
| Issue 附件与搜索                                | Codeup 仓库 API 不提供此资源                           | 暂不提供：Gitee 的字母数字编号与宿主的数字 Issue 编号契约不兼容 |

合并会重新读取平台门禁，不信任客户端传入的旧状态；Codeup 必须明确返回 `NO_CONFLICT`，
Gitee 必须明确返回 `mergeable: true`，检测中、失败或缺失状态均不会发送合并请求。提交后再次读取请求，只有平台确认
已合并才返回成功。不会自动删除源分支或关闭相关 Issue，也不会自动重试写操作。

已打开的请求按源仓库和分支匹配，允许本地存在未推送提交。已关闭或已合并的请求必须匹配
当前 `HEAD` 的源提交 SHA；不会因为复用了分支名而挂上旧请求，也不会误用 merge commit SHA。
跨仓库检出的 fetch URL 和 preferred push URL 使用源仓库，并保留 HTTP/SSH 传输偏好。

普通列表和时间线分页检测重复页并限制最多 100 页；普通列表返回最多 500 条。部分时间线加载失败时保留
已经读取的内容并显示错误。

Codeup 当前分支轮询采用渐进查找：每轮最多读取 3 页开放请求及 3 页历史请求，始终刷新第一页，
后续轮询从上次位置继续查找，因此大型仓库不会因历史超过 100 页而报错。首次查找较老的 MR
可能需要多个轮询周期；完成整段查找后，第一页不变时不再重扫历史。按编号查询和检出不受此限制。
匹配过的 MR 只记住编号，每轮仍重新获取详情、校验源仓库／分支／SHA 和门禁；不会缓存状态或凭据。
查找记录最多保留 128 组，并按凭据、配置、仓库、分支和 SHA 隔离；宿主失效通知、创建／合并及插件卸载
会清除对应记录。Gitee 同仓库请求使用稳定的仓库 ID 识别，兼容迁移后仍在使用的旧 remote 路径。

## 扩展与测试边界

- `shared/`：连接设置、RPC、提供者定义和合并事实。
- `server/connection.ts`：HTTP 客户端、认证、令牌绑定和仓库匹配。
- `server/common.ts`：分页、搜索、检出与 SDK 服务补全。
- `server/codeup.ts`、`server/gitee.ts`：平台路径、响应校验和业务映射。
- `client/`：宿主原生设置页及 Forge 客户端注册。

新增平台时实现一个服务适配器，补充共享定义和连接配置，然后在两个入口注册。
平台差异留在适配器中，通用传输复用宿主工具；不需要引入平台 CLI。

自动测试使用可控 HTTP 响应覆盖请求格式、状态识别、分页、凭据隔离、检出和合并失败。
它们不使用真实个人令牌，也不在真实仓库执行创建或合并。Gitee 的公开仓库只读响应另行用于
核对 v5 数据形状。真实私有仓库权限、服务端策略及桌面/手机端显示仍需在目标宿主配置后验证。

接口依据：

- [Paseo 插件文档](https://paseo.sh/docs/plugins/v0.8/reference)，以及目标分支中的同名文档。
- [阿里云官方云效 MCP / OpenAPI 参考](https://github.com/aliyun/alibabacloud-devops-mcp-server/tree/master/operations/codeup)。
- [Codeup Repository OpenAPI Schema](https://github.com/aliyun/alibabacloud-devops-mcp-server/blob/master/docs/repository.swagger.json)。
- [Gitee API v5](https://gitee.com/api/v5/swagger) / [OpenAPI Schema](https://gitee.com/api/v5/swagger_doc)。
