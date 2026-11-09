# Owner 认证的远程 iPhone 配对

本维护包独立于 `maintenance/owner-access` 的归档/usage 两包，完整重建 **bridge Host 和浏览器 client**，不是复用旧前端的 Host-only 补丁。构建基线和官方模板由 `release.json` 锁定。

## 行为与安全边界

- 原 `GET /remote-bridge/pair/token` 完全不改，仍只允许本机回环。
- 新 `GET /remote-bridge/pair/remote-info` 读取远程功能状态和可信地址，不签发令牌。
- 新 `POST /remote-bridge/pair/remote-token` 显式签发一次性码，body 为 `{ "origin": "https://phone.example" }`。
- 新增两个接口都经官方 `connection.admit`，只接受 owner；未知、错误或不兼容服务一律拒绝。
- 默认 `remotePairingEnabled:false`、`trustedPairingOrigins:[]`；字符串 true 或错误白名单不会被宽松转换。
- 可信地址必须是精确规范化的 HTTPS origin，无路径、尾斜杠、用户信息、查询、fragment 或通配符。不要把域名硬编码到源码。
- POST 必须同源 Origin/Host、无跨站 fetch metadata，JSON <=1024 字节，上传10秒超时；错误上传关闭连接，不无期限排空。
- 不设置 CORS；不信任客户端提交的“新增可信地址”。浏览器输入只能选已在服务端配置的地址。
- 响应 no-store/no-referrer；新接口不记录令牌。二维码只在内存中，关闭/换页签/改地址会清除，晚到响应不会恢复旧码。
- 远程取码仅点击按钮时执行；不自动刷新，30秒过期、一次有效。下次成功远程取码会作废上一个远程码，但不会影响独立本机码、进行中的 nonce 或已配对设备。多个管理员同时取远程码会互相替换，应协调操作。
- 这不是低权限分享：被授予 owner 网页访问的管理员可以给新设备配对；手机是高权限设备。

## 配置示例

在服务端 profile 覆盖已有 bridge 行，保留既有 relay/tunnel 等配置：

```yaml
- id: web-ui-remote-bridge
  name: '@linxin666/dsh-remote-bridge'
  config:
    remotePairingEnabled: true
    trustedPairingOrigins:
      - https://phone.example
```

这是地址许可而非自动建立公网隧道。先确认相应 `wss://phone.example/ios/v1` 已由可信 HTTPS 入口转发到 bridge，且仍由设备认证保护。

反向代理应保持真实 Host/Origin、POST body 和浏览器凭证，仅把**这两个精确接口**交给既有认证入口，不清空身份校验头来伪装本机。原本机取码接口不对公网开放。两个新接口建议关闭访问日志并加 `Cache-Control:no-store`（后端已设置）；禁止缓存响应体。设备 WebSocket `/ios/v1` 不应注入网页 owner cookie，应保留设备 Bearer Authorization。

如果整个网站由 Basic Auth + 服务端 owner cookie 桥接，所有通过该外层认证的管理员都会取得此能力。不要把“填写了域名”当成权限验证。

## 构建与校验

需要 Node >=24.11、npm、Git、tar 和锁定版本的官方 DSH Host SDK。浏览器 SDK declarations 和构建工具由独立锁文件固定；不在 monorepo 根安装依赖。

```sh
npm ci --prefix maintenance/remote-pairing/tools --ignore-scripts
node maintenance/remote-pairing/build.mjs --dsh-root /path/to/installed/@deepseek-ai/dsh
node maintenance/remote-pairing/verify.mjs maintenance/remote-pairing/dist/<version>-<git短SHA>
```

构建执行全部 bridge Node/jsdom 测试、源码与测试类型检查，再使用上游共享 loader/CSS preset 同时编译两端。官方模板 sha512 校验后仅保留公开包壳，源码、测试、locale、旧 lib 全部用 fork 重建替换。构建记录 SDK、锁文件、源树、共享构建文件、Host/client 哈希和 Git 提交。

`--allow-dirty` 只用于演练，校验脚本拒绝安装这类产物。两个文件（tgz 和 manifest）只有全部成功才原子发布到 dist，不会安装、发布 npm、修改配置或重启。

GitHub Actions：**BJA remote pairing bridge**，维护分支相关推送或手动触发后下载产物。主机服务、App 和已有配对设备不参与构建测试。

## 安装与回退

1. 备份 profile/锁文件及上一版包，核对实际 DSH SDK 与产物锁定版本。
2. 保留全家桶，通过官方插件管理器安装这个同名 bridge 包，覆盖已有 `web-ui-remote-bridge` 行，不能新增第二个 bridge 实例。
3. 若已有同名单独安装包需变更来源，按管理器提示先移除旧直接包再安装新包；保留全家桶和设备名册。
4. 服务端显式开启远程配对并设置可信地址；按需配置两个精确代理接口。
5. 通知用户后重启 DSH（会断开当前 GUI 与手机连接），刷新实际网页。浏览器插件修改不能仅靠换 Host 包假定已刷新。
6. 验证未登录401/403、跨源拒绝、错误域名拒绝、本机旧接口公网403、GET mint405、合法同源POST200且二维码指向白名单。检查关闭/换页签/超时行为，保留已配对设备。
7. 出错时关闭功能并恢复上一版包/对应配置，重启验证；不要删除设备名册，不改回环伪装绕过。

未来跟随上游正式 tag，审查 bridge 和 shared build preset 的变动，更新 release/template/SDK 锁定信息并完整重跑。不要让归档/usage 的 Host-only 流程接受 bridge 前端变更，也不要把本包升级误当成全家桶升级。
