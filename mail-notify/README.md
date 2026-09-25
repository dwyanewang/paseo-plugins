# mail-notify

Paseo 本地插件：主 agent 完成、失败或等待批准时，通过 SMTP 发一封邮件。收件地址填 QQ 邮箱，并在微信
设置 → 通用 → 辅助功能 里启用"QQ 邮箱提醒"，通知就会出现在微信里。它不依赖 iLink，也就没有
"用户最近发过消息才能推送"的窗口限制。

## 配置

在 Paseo App 的 设置 → 插件 → 邮件通知 里填写：

- 服务商：QQ、163、126 邮箱有预设（SSL 465 端口），其他选"自定义"填服务器和端口。
- 发件地址：同时作为 SMTP 登录账号。建议单独开一个邮箱当发件人，这样 daemon 里存的不是主邮箱的凭据。
- 授权码：在发件邮箱的网页设置里开启 SMTP 服务后生成，不是登录密码。
- 收件地址：绑定了微信"QQ 邮箱提醒"的 QQ 邮箱。

所有字段都存在 daemon 的 `server.secrets`，授权码不会回传给客户端，也不进日志。保存后点"发送测试邮件"确认。
如果手机装了 QQ 邮箱 App 而微信没有提醒，在 QQ 邮箱 App 里关掉"仅在 QQ 邮箱客户端提醒"。

## 通知规则

与 wechat-notify 相同：60 秒完成门槛、20 秒权限延迟、5 秒合并窗口，检测到后台子 agent 时挂起复查；
`server.presence()` 报告用户正在使用 Paseo 时跳过。邮件标题是通知第一行，多条合并时标注条数。

正文按 agent 分段，每段包括：

- 摘要行、agent 标题、工作区未提交改动（+行数 −行数）；
- 完成或失败：本轮你的指令（前 500 字）、agent 最后的回复（前 3000 字）、修改过的文件（最多列 20 个）、
  执行命令条数和失败的工具调用次数、任务清单进度；
- 失败：完整错误（前 2000 字）；
- 等待批准：工具的标题、说明和具体内容（命令和目录、要改的 diff，或原始参数），前 1500 字。

邮件同时带 HTML 和纯文本两个版本。HTML 版按通知类型着色（完成绿、失败红、等待批准黄），agent 回复按 Markdown
渲染，diff 的增删行分别着色。回复里的原始 HTML 只显示、不执行，图片显示为链接，打开邮件时不会加载远程资源。
这些内容会以明文存放在发件和收件邮箱里。

插件每次启动（安装、`paseo plugin reload`、daemon 重启）都会发一封"🔔 Paseo 邮件通知已连接"，
收不到就看 `paseo plugin logs mail-notify`。

## 开发

```bash
npm install --ignore-scripts --package-lock=false --legacy-peer-deps
npm run typecheck
npm test
paseo plugin install /absolute/path/to/mail-notify
```

Zod 固定为 `4.4.3`，与宿主一致。装出两份不同版本的 zod 时，`defineRpc` 的类型比对会让 tsc 内存溢出。
运行时依赖只有 `nodemailer`，daemon 直接从本目录的 `node_modules` 加载它。
