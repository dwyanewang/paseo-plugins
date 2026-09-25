# wechat-notify

仅 daemon 侧的 Paseo 本地插件。它监听主 agent 的完成、失败和等待批准事件，通过腾讯 iLink Bot
`sendmessage` 直连推送到个人微信，不调用 `getupdates`，也不会发送 `context_token`。

首次启动时，若 `server.secrets` 尚未配置，会从 `~/.hermes/weixin/accounts/` 的 Hermes 账号文件
导入 `ilink.token`、`ilink.base-url` 和 context-tokens 文件的键（收件人）；context token 的值不会被使用。
凭据始终留在 daemon secrets，不会进入日志或客户端。

开发：

```bash
npm install
npm run typecheck
npm test
```

安装到本机 daemon：

```bash
paseo plugin install /absolute/path/to/wechat-notify
paseo plugin reload wechat-notify
```

通知遵循 60 秒完成门槛、20 秒权限延迟、5 秒合并窗口，并在检测到 Paseo 或提供方后台子 agent
时挂起复查。

插件每次启动（安装、`paseo plugin reload`、daemon 重启）都会发一条"🔔 Paseo 微信通知已连接"。
收不到这条消息，就说明凭据或网络有问题，原因见 `paseo plugin logs wechat-notify`。
