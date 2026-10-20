# 影策即梦本机 Runtime

这个 Runtime 只监听本机 `127.0.0.1:17371`，用于让影策网页调用当前电脑已安装并登录的官方即梦 CLI。它不把 Cookie、浏览器 Profile 或登录令牌上传到影策服务器。

## Windows

先安装 Node.js 20 LTS 和官方即梦 CLI，并在 PowerShell 中确认 CLI 已可用。然后在本目录执行：

```powershell
npm install
$env:FRAMEFIELD_TRUSTED_WEB_ORIGINS = "https://min99.cc,https://www.min99.cc"
npm run build
npm start
```

窗口保持运行后，打开 `https://min99.cc/settings?section=local-cli`，点击“重新连接”。首次连接会为该网页 Origin 创建本机授权；在页面中完成官方 CLI 登录。

## macOS

```bash
npm install
FRAMEFIELD_TRUSTED_WEB_ORIGINS='https://min99.cc,https://www.min99.cc' npm run build
FRAMEFIELD_TRUSTED_WEB_ORIGINS='https://min99.cc,https://www.min99.cc' npm start
```

每台电脑的 Runtime、官方 CLI 登录状态和生成队列完全独立。不要把 17371 端口映射到公网。
