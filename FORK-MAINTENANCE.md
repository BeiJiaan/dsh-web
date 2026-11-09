# BeiJiaan 维护分支

本 fork 的维护分支为 **`bja-owner-access`**，基于上游正式标签 **`v0.4.16`**。保留上游目录、包名和源码中的版本声明，分别维护 Host 认证补丁和完整前后端的 bridge 配对改进：

- 会话归档：默认关闭、显式开启的 DSH owner 认证远程访问。
- 用量统计：同样接入正式认证，不依赖反向代理伪装回环。

- 手机桥接：默认关闭的 Owner 认证远程配对页签、精确 HTTPS 地址白名单、独立 POST 取码；原本机取码限制不改。

设置桥接采用插件已有配置，不修改设置插件源码。生图插件属于另一个仓库。

Bridge **必须完整构建 Host + client**，使用独立的 [远程配对维护指南](maintenance/remote-pairing/README.md) 和 Actions **BJA remote pairing bridge**；它不是下面的归档/usage 两包流水线的一部分。

## 构建与获取安装包

完整操作与升级/回退说明见 [维护指南](maintenance/owner-access/README.md)。

```sh
npm ci --prefix maintenance/owner-access/tools --ignore-scripts
node maintenance/owner-access/build.mjs --dsh-root /path/to/installed/@deepseek-ai/dsh
```

构建工具要求 Node >=24.11、npm、Git 和 tar，当前审查 SDK 为 DSH 0.2.2-rc.1。先执行 268 + 142 项 Host 测试、类型检查、编译及完整性校验，通过后产出两个 tgz 和 manifest。

也可在 Actions 中运行 **BJA owner-access packages**，成功后下载 artifact。没有自动生产部署、没有 npm 发布、没有自动重启。

源码只包含可复用修复和测试；真实域名、Cookie、密钥、profile 与 nginx 生产配置均不进入仓库。已运行的旧修复版不会因为建立 fork 而自动变化。
