# SampleFlow 公网验收方案研究（截至 2026-09-03）

> 本文主体为官方资料研究和备选方案，不是当前环境的重配步骤。当前使用 Quick Tunnel + 独立入口 Cookie 会话 + 系统账号；已授权接入独立真实副本并建立 9 个角色账号。原库未改。初期 Basic Auth 已因浏览器遇到业务 401 后反复弹框而替换，本文历史 Basic Auth 示例不得用于当前 SampleFlow。实际状态见 `handoff.md` 的“当前运行环境与操作入口”及桌面 `SampleFlow公网验收操作指南.md`；禁止按旧示例重新初始化现有试用库或丢失验收 Compose 覆盖文件。价格、免费额度和产品限制会变化，执行前应再次核对官方来源。

## 1. 先给结论

对当前 SampleFlow，推荐顺序如下：

1. **已有 Cloudflare 托管域名：named Cloudflare Tunnel + Cloudflare Access 邮箱 OTP。** URL 稳定、无需开放家庭网络入站端口，客户浏览器无需安装客户端；Cloudflare Zero Trust Free 当前适合 50 人以内或 PoC。[Tunnel 官方概览](https://developers.cloudflare.com/tunnel/)、[Access 价格](https://www.cloudflare.com/plans/zero-trust-services/)
2. **只做几小时预演、没有域名：Cloudflare Quick Tunnel。** 一条命令得到随机 HTTPS URL，但无 SLA、URL 不稳定、上限 200 个并发请求且不支持 SSE，只适合开发/测试。[Quick Tunnel 官方限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
3. **Cloudflare 在客户网络实测不稳：ngrok assigned development domain，或香港/中国内地轻量云。** ngrok 配置很快且有稳定的账号 development domain；免费额度当前为 1 GB/月、20,000 HTTP(S) 请求/月、最多 3 个在线 endpoint。[ngrok 计划限制](https://ngrok.com/docs/pricing-limits/how-ngrok-charges)
4. **客户主要位于中国内地且验收稳定性高于操作简便：便宜 VPS + frp，或直接在轻量云运行现有 Compose。** 这是推断性建议：Cloudflare 官方明确指出，跨中国网络边界的站点会面临明显时延和可靠性问题；Cloudflare China Network 又是 Enterprise 的单独订阅，不是普通免费 Tunnel。[Cloudflare China Network](https://developers.cloudflare.com/china-network/)

当前项目**不需要分别暴露前端和 API**：生产式 Web 容器在 `8080` 提供页面，并把同源 `/api/` 转发给内部 API `3000`。验收环境仅把 Web 映射到宿主机回环地址 `127.0.0.1:18080`，再由公网入口转发；API、PostgreSQL `5432/55432` 和 `/internal/metrics` 都保持私有。这同时避免跨域 Cookie、CORS 和 CSRF 复杂度。

## 2. 已确认的项目技术栈与入口

以下是当前仓库的确认事实，不是通用模板：

| 项目 | 当前实现 |
|---|---|
| 前端 | React 19 + Vite 8；开发端口 `5174` |
| 后端 | Fastify 5 + TypeScript；API 端口 `3000` |
| 数据库 | PostgreSQL 16；本地开发映射端口 `55432` |
| 生产式入口 | Compose 的 Web/Nginx，宿主机默认 `8080` |
| API 路由 | Web/Nginx 将同源 `/api/` 转发至 Compose 内部 `api:3000` |
| Origin/CSRF | API 用 `APP_ORIGINS` 精确校验浏览器 Origin；写请求另有 CSRF token |
| Cookie | `NODE_ENV=production` 时会话与 CSRF Cookie 自动带 `Secure`；`SameSite` 分别为 `Lax`、`Strict` |
| 代理信任 | `TRUST_PROXY_CIDR` 由 Compose 设置为专用代理网段，不应扩大到 `0.0.0.0/0` |
| 容器网络 | 数据库仅在内部 `backend` 网络；API 不映射宿主机端口；只有 Web 映射 `8080` |

因此最小正确入口是：

```text
客户浏览器 HTTPS
  -> Cloudflare/ngrok/VPS 入口
  -> Windows 127.0.0.1:18080
  -> Web Nginx
       /       -> React 静态文件
       /api/*  -> api:3000
  -> PostgreSQL（仅内部网络）
```

## 3. 方案对比

“国内可用性”是基于官方网络说明作出的工程判断，不是 SLA。

| 方案 | 易用性 | 当前成本口径 | URL | 稳定性 | 中国内地可用性 | 保护能力 | 适合本项目 |
|---|---:|---:|---|---|---|---|---|
| Cloudflare Quick Tunnel | 最简单 | 免费 | 随机 `trycloudflare.com` | 无 SLA；仅测试；200 in-flight；无 SSE | 必须现场实测，跨境路径可能波动 | 项目自身登录；不能把随机 URL 当强访问控制 | 临时预演 |
| Cloudflare named Tunnel + Access | 简单 | Tunnel 可用于所有计划；Zero Trust Free 当前 50 用户 | 自有稳定域名 | 明显优于 Quick Tunnel；免费计划无付费 SLA | 必须现场实测；普通全球网络不等于 China Network | Access 邮箱列表、OTP/IdP、会话策略 | **首选** |
| ngrok Free | 简单 | $0；1 GB/月、20k HTTP 请求/月、最多 3 endpoint | 账号 assigned dev domain 稳定 | 验收通常够用；受免费额度约束 | 必须客户网络实测 | Basic Auth/OAuth 可做；免费身份 MAU 当前 3 | 次选 |
| frp + VPS | 中等 | frp 免费开源；VPS、域名、流量按供应商 | IP 或自有域名稳定 | 由 VPS、线路和自运维决定 | 香港节点通常免内地 ICP；内地节点线路更近但域名通常需备案（推断） | frp token + HTTP Basic Auth + Caddy HTTPS + 防火墙 | 可控备选 |
| Railway | 中等 | Free 当前 $1/月信用；Hobby $5/月且该费用计入用量 | 平台域名/自有域名 | 云端运行，不依赖开发机在线 | 跨境平台，必须实测 | 平台 TLS + 项目登录 | 需改造成平台多服务，不原样运行 Compose |
| Render | 中等 | 有免费 Web/Postgres；免费 Postgres 30 天到期、免费 Web 会休眠且无持久盘 | `onrender.com`/自有域名 | 免费层有冷启动和额度限制 | 跨境平台，必须实测 | 平台 TLS + 项目登录 | 需 Blueprint/私网适配；纯免费多服务受限 |
| 国内轻量云 + Compose | 中等 | 以购买页实时价格为准 | 公网 IP 或备案域名 | 不依赖本机；最接近现有生产 ADR | 通常最好，但地域、运营商需实测 | 防火墙 + HTTPS + 应用登录；可再加 Basic Auth | **长期验收首选备选** |

官方依据：Railway [Compose 映射说明](https://docs.railway.com/guides/docker-compose)、[计划价格](https://docs.railway.com/pricing/plans)；Render [免费层限制](https://render.com/docs/free)、[Blueprint](https://render.com/docs/infrastructure-as-code)、[私网限制](https://render.com/docs/private-network)；腾讯云 [轻量服务器 Docker 与备案说明](https://cloud.tencent.com/document/product/1207/60423)。

## 4. 共同准备：以隔离的生产式 Compose 启动 SampleFlow

### 4.1 Windows 前置条件

若尚未安装 Docker Desktop，可按 [Docker 官方 Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/) 安装。官方推荐多数用户使用 WSL 2 的 per-user 模式；商业使用还应核对 Docker Desktop 许可条件。

在 PowerShell 中确认：

```powershell
docker version
docker compose version
git status --short --branch
```

### 4.2 创建仅本机保存的验收环境文件

仓库已提供 `.env.acceptance.example`，并让验收 Web 只监听宿主机回环地址 `127.0.0.1:18080`。这样局域网设备不能绕过 Tunnel/Access 直连。`.env.acceptance.local` 已由 `.gitignore` 排除，仍须确认不提交。公网 Origin 必须是客户最终打开的 URL，**无路径、无末尾斜杠**。

```powershell
Copy-Item -LiteralPath '.env.acceptance.example' -Destination '.env.acceptance.local'
notepad .env.acceptance.local
git check-ignore .env.acceptance.local
```

生成四个不同的数据库秘密并分别填入文件；命令会把秘密显示在当前终端，不要截图或写入 shell 历史：

```powershell
function New-SampleFlowSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [Convert]::ToBase64String($bytes)
}
1..4 | ForEach-Object { New-SampleFlowSecret }
```

至少替换：

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=18080
APP_ORIGINS=https://accept.example.com
SAMPLEFLOW_PROXY_SUBNET=172.31.240.0/24

POSTGRES_PASSWORD=<不同的长随机密码>
DB_MIGRATION_PASSWORD=<不同的长随机密码>
DB_APP_PASSWORD=<不同的长随机密码>
DB_BACKUP_PASSWORD=<不同的长随机密码>
```

说明：

- 当前 API 并没有 Django `ALLOWED_HOSTS`；对应的安全门是精确 `APP_ORIGINS`、CSRF 和 Nginx 同源代理。
- 生产 Compose 已把 API 的 `NODE_ENV` 固定为 `production`，会话与 CSRF Cookie 会带 `Secure`；不要复制开发环境里的 `SESSION_COOKIE_SECURE=false`。
- 多个允许 Origin 用逗号分隔，例如 `APP_ORIGINS=https://accept.example.com,https://备用域名`。只填明确域名，不使用 `*`。
- 保持 `TRUST_PROXY_CIDR`/`SAMPLEFLOW_PROXY_SUBNET` 为 Compose 专用网段，不信任任意公网代理。
- 外层 TLS 可以在 Cloudflare/ngrok/Caddy 终止，入口工具到本机 `127.0.0.1:18080` 仍可用 HTTP；浏览器端必须始终使用 HTTPS。
- 始终使用 Compose 项目名 `sampleflow-acceptance`，使验收数据库卷与开发环境、其他 Compose 项目隔离。

### 4.3 首次启动

沿用仓库已验证的部署顺序：

```powershell
$composeArgs = @('-p', 'sampleflow-acceptance', '--env-file', '.env.acceptance.local')
docker compose @composeArgs build api web
docker compose @composeArgs up -d --wait db
docker compose @composeArgs --profile operations run --rm db-provision-roles
docker compose @composeArgs --profile operations run --rm db-migrate
docker compose @composeArgs --profile operations run --rm admin-bootstrap
docker compose @composeArgs up -d --wait api web
curl.exe --fail http://127.0.0.1:18080/healthz
curl.exe --fail http://127.0.0.1:18080/api/ready
```

`admin-bootstrap` 只在首次创建该验收库时执行。临时密码只显示一次，应放入批准的密码管理器；不要把管理员账号直接给客户。应在应用内建立完成验收所需的最小权限账号，并通过单独安全通道交付。验收数据使用独立、脱敏副本；不要运行开发 seed，也不要擅自复制真实业务库。

## 5. 方案 A：Cloudflare Tunnel

### 5.1 Windows 安装

Cloudflare 官方提供 Windows x64 executable 和 MSI；Windows 版不会自动更新，应在验收前手工检查版本。[官方下载页](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)

本机 WinGet 可直接安装：

```powershell
winget install --id Cloudflare.cloudflared --exact
cloudflared --version
```

如果 WinGet 不可用，可直接从 Cloudflare 官方 GitHub release 下载 x64 executable：

```powershell
$binDir = Join-Path $env:LOCALAPPDATA 'Programs\cloudflared'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Invoke-WebRequest `
  -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
  -OutFile (Join-Path $binDir 'cloudflared.exe')
$env:Path = "$binDir;$env:Path"
& (Join-Path $binDir 'cloudflared.exe') --version
```

也可从官方下载页取 x64 MSI。上面的 `PATH` 只对当前 PowerShell 会话生效；新窗口若找不到命令，就再次设置或使用完整 executable 路径。不要使用第三方下载站。

### 5.2 无账号、临时 URL：Quick Tunnel

先把 `.env.acceptance.local` 的 `APP_ORIGINS` 改为命令输出的实际 HTTPS URL并重建 API。由于 URL 只有启动后才知道，最稳妥的顺序是：先临时启动 Tunnel，记录 URL，再按 4.3 节首次启动；若服务已经启动，则重建 API/Web。

终端 1：

```powershell
cloudflared tunnel --url http://127.0.0.1:18080
```

命令会输出类似 `https://random-words.trycloudflare.com` 的 URL。随后在另一个 PowerShell：

```powershell
# 把 .env.acceptance.local 中 APP_ORIGINS 改成实际 URL 后执行
$composeArgs = @('-p', 'sampleflow-acceptance', '--env-file', '.env.acceptance.local')
docker compose @composeArgs up -d --build --force-recreate api web
curl.exe --fail https://random-words.trycloudflare.com/api/ready
```

确认事实：Quick Tunnel 无需把域名加入 Cloudflare；随机 URL 只在进程运行期间有效；无 SLA；200 个并发中的请求上限；不支持 SSE；若默认 `.cloudflared/config.yaml` 存在，Quick Tunnel 当前不受支持。[官方文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

安全结论：随机 URL 不是密码。根据 Access 要求应用使用账户中的 active domain，而 `trycloudflare.com` 随机 hostname 不属于客户 zone，可推断 Quick Tunnel 不能直接套用标准 Self-hosted Access 流程。敏感验收应使用下一节，或至少只使用专门的低权限验收账号和脱敏/隔离数据。

### 5.3 稳定 URL：named Tunnel + 自有域名

前提：域名对应 zone 已托管到 Cloudflare。以下是 locally-managed tunnel 的命令式流程；也可以在 Zero Trust Dashboard 创建 remotely-managed tunnel并复制 Windows token 命令。

```powershell
cloudflared tunnel login
cloudflared tunnel create sampleflow-acceptance
cloudflared tunnel route dns sampleflow-acceptance accept.example.com
```

把命令输出的 tunnel UUID 和 credentials JSON 实际路径填入 `%USERPROFILE%\.cloudflared\sampleflow-acceptance.yml`：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: C:\Users\<Windows用户名>\.cloudflared\<TUNNEL_UUID>.json

ingress:
  - hostname: accept.example.com
    service: http://127.0.0.1:18080
  - service: http_status:404
```

最后一条 catch-all 规则不可省略。检查并运行：

```powershell
$tunnelConfig = Join-Path $env:USERPROFILE '.cloudflared\sampleflow-acceptance.yml'
cloudflared tunnel --config $tunnelConfig ingress validate
cloudflared tunnel --config $tunnelConfig ingress rule https://accept.example.com/api/ready
cloudflared tunnel --config $tunnelConfig run sampleflow-acceptance
```

这些命令和 DNS CNAME 行为见 [Cloudflare 本地管理 Tunnel 官方流程](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)；ingress 自上而下匹配且必须以 catch-all 结束，见 [配置文件官方说明](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)。公司网络若限制出站连接，需要允许 `cloudflared` 到 Cloudflare 的 TCP/UDP `7844`。[连接方式说明](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/)

多服务示例（只在客户确实需要分别访问时使用）：

```yaml
ingress:
  - hostname: accept.example.com
    service: http://127.0.0.1:18080
  - hostname: docs-accept.example.com
    service: http://127.0.0.1:9000
  - hostname: preview-accept.example.com
    service: http://127.0.0.1:9001
  - service: http_status:404
```

每个 hostname 都要创建 DNS route，并加入对应应用的精确 Origin/Host 配置。**SampleFlow 本身不应采用额外入口**：当前 API 没有宿主机端口映射，且单一 `18080` 已覆盖完整验收。上述多入口只适用于另一个确实独立、已鉴权的 HTTP 服务；绝不要为验收暴露 API `3000`、PostgreSQL 或 `/internal/metrics`。

### 5.4 用 Cloudflare Access 保护

Cloudflare Access 是身份感知代理，会在请求到达 Tunnel origin 前校验策略。[Access Web 应用说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)

Dashboard 路径：

1. Zero Trust → Settings → Authentication，启用 One-time PIN，或接入已有 IdP。
2. Access controls → Applications → Add an application → Self-hosted。
3. Application domain 填 `accept.example.com`，不要只保护 `/login`；应保护整个 hostname。
4. 新建 `Allow` policy，Include 选择 `Emails` 并逐一填写客户邮箱；Require 选择 `One-time PIN`。
5. 会话时长建议与 SampleFlow 的 8 小时会话相同或更短；先用客户真实浏览器完成一次登录测试。

OTP 可直接给批准邮箱发单次 PIN，PIN 当前 10 分钟过期。官方特别警告：不要只写“OTP 登录方式”而不限制具体邮箱/域名，否则任何邮箱都可能请求验证码。[OTP 官方说明](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)、[常见 Access 策略](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

若客户邮件网关扫描登录链接，OTP 可能被提前消费；重新请求验证码并让客户允许 `noreply@notify.cloudflare.com`。浏览器严格阻止第三方 Cookie 时也可能导致 Access 跳转/请求异常，应按 [Access Cookie 官方排查](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/) 为应用域名和团队域名放行。

### 5.5 中国内地网络判断

确认事实：Cloudflare 官方说明，跨中国网络边界的流量存在明显时延和可靠性问题；内地节点的 China Network 是 Enterprise 计划之外的单独订阅，并要求有效 ICP 备案/许可及内容审核。[China Network 概览](https://developers.cloudflare.com/china-network/)、[开通条件](https://developers.cloudflare.com/china-network/get-started/)

工程推断：普通免费/自助 Cloudflare Tunnel 不能等同于“中国内地加速”。正式验收前至少让客户在实际办公网络和手机热点各测试一次首页、登录、列表、下载和 Excel 上传；若出现间歇超时，不应继续调 CORS，应切 ngrok 或亚洲/国内 VPS 做对照。

## 6. 方案 B：ngrok

### 6.1 Windows 安装与授权

按 [ngrok Windows 官方下载页](https://ngrok.com/download/windows) 安装；页面会提供当前安装方式和账号 authtoken。

```powershell
winget install ngrok -s msstore
ngrok version
ngrok config add-authtoken <从控制台复制的token>
```

不要把 authtoken 写进仓库、截图或交给客户。

### 6.2 暴露完整 SampleFlow

免费账号当前会得到一个 assigned development domain。先在 ngrok 控制台确认准确域名，把它写入 `.env.acceptance.local`：

```dotenv
APP_ORIGINS=https://<你的assigned-development-domain>
```

重建服务后启动：

```powershell
$composeArgs = @('-p', 'sampleflow-acceptance', '--env-file', '.env.acceptance.local')
docker compose @composeArgs up -d --build --force-recreate api web
ngrok http 18080
```

如果 CLI/控制台给出的稳定域名需要显式指定：

```powershell
ngrok http 18080 --url=https://<你的assigned-development-domain>
```

免费计划的确认限制截至本文日期为：1 个 assigned development domain、最多 3 个同时在线 endpoint、1 GB/月出站流量、20,000 HTTP(S) 请求/月；自有域名不在 Free/Hobbyist 提供；随机 TCP 地址在 Free 需要信用卡验证。免费 HTML 页面还会先显示 ngrok interstitial，客户点击 Visit 后由 Cookie 在 7 天内抑制；API 请求不受该页面影响。[免费计划官方限制](https://ngrok.com/docs/pricing-limits/free-plan-limits)、[完整计费指标](https://ngrok.com/docs/pricing-limits/how-ngrok-charges)

### 6.3 多端口配置

仍建议只开 `18080`。若另一个独立服务确实需要公网访问，可用 `%LOCALAPPDATA%\ngrok\ngrok.yml`（实际配置路径以 `ngrok config check` 输出为准）：

```yaml
version: "3"
agent:
  authtoken: <仅保存在本机的token>
endpoints:
  - name: sampleflow-web
    url: https://<assigned-development-domain>
    upstream:
      url: http://127.0.0.1:18080
  - name: other-service
    url: https://<另一个已保留域名>
    upstream:
      url: 9000
```

```powershell
ngrok config check
ngrok start --all
```

计划限制按“在线 endpoint”计数；免费层当前最多 3 个。不要为了“多端口”把数据库变成 TCP endpoint。

官方 v3 配置格式与 `ngrok start --all` 见 [Agent 配置说明](https://ngrok.com/docs/gateway/agent/config/v3)。免费层只有一个 development domain，因此前端与 API 各自拥有稳定 hostname 并不适合免费层；同源反代后只开一个 endpoint 更简单。

### 6.4 Basic Auth

ngrok Traffic Policy 的 `basic-auth` action 当前本身不收 TPU，但账户整体仍受计划用量约束。[TPU 官方价格表](https://ngrok.com/docs/pricing-limits/traffic-policy-unit-pricing)

`policy.yml`：

```yaml
on_http_request:
  - actions:
      - type: basic-auth
        config:
          credentials:
            - acceptance:<强随机密码>
```

```powershell
ngrok http 18080 --traffic-policy-file .\policy.yml
```

Basic Auth 密码应通过密码管理器或独立通道发送，验收后立即轮换/删除。若使用 OAuth/OIDC，免费计划当前只有 3 个身份 MAU/月，客户人数超过 3 时不应依赖免费身份层。[ngrok 计划限制](https://ngrok.com/docs/pricing-limits/how-ngrok-charges)

若跨域前端/API前面使用认证策略，还要特别处理 CORS preflight；ngrok 官方说明部分认证配置默认会阻断 `OPTIONS`。SampleFlow 的单一同源 Web 入口没有这个额外问题。[ngrok FAQ](https://ngrok.com/docs/faq)

## 7. 方案 C：frp + 便宜 VPS

frp 是开源反向代理，支持 NAT 后本地服务、HTTP 自定义域名、token 鉴权和 HTTP Basic Auth；自 v0.52.0 起 TOML/YAML/JSON 为推荐格式，INI 已弃用。[frp 官方仓库](https://github.com/fatedier/frp)

推荐结构：客户 HTTPS → VPS Caddy → VPS 本机 frps HTTP vhost → frp 隧道 → Windows `127.0.0.1:18080`。只开放公网 `80/443` 和 frps 控制端口 `7000`；VPS 的 `8080` 只允许本机访问。

### 7.1 VPS 端 `frps.toml`

从 [frp 官方 Releases](https://github.com/fatedier/frp/releases) 下载与服务器架构匹配的 release：

```toml
bindPort = 7000
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = 8080
transport.tls.force = true

auth.method = "token"
auth.token = "<强随机FRP_TOKEN>"
```

启动测试：

```sh
./frps verify -c ./frps.toml
./frps -c ./frps.toml
```

生产验收应把 `frps` 做成 systemd 服务，并让安全组只允许：`80/tcp`、`443/tcp`，以及 `7000/tcp` 仅来自开发者当前公网 IP。不要开放 dashboard；确需使用时只监听 loopback 并设置独立密码。该最小示例强制 TLS 加密但没有固定 frps 身份；承载敏感数据时还必须按 [frp TLS 官方说明](https://gofrp.org/en/docs/features/common/network/network-tls/) 配置 `certFile`、`keyFile` 与客户端 `trustedCaFile`，否则改用 named Cloudflare Tunnel。

### 7.2 Windows 端 `frpc.toml`

```toml
serverAddr = "<VPS公网IP>"
serverPort = 7000
transport.tls.enable = true

auth.method = "token"
auth.token = "<与服务端相同的FRP_TOKEN>"

[[proxies]]
name = "sampleflow-acceptance"
type = "http"
localIP = "127.0.0.1"
localPort = 18080
customDomains = ["accept.example.com"]
httpUser = "acceptance"
httpPassword = "<独立强随机BasicAuth密码>"
```

```powershell
.\frpc.exe verify -c .\frpc.toml
.\frpc.exe -c .\frpc.toml
```

`httpUser/httpPassword` 只适用于 frp 的 HTTP proxy。frps 与 frpc 间 token 是连接器鉴权，不能替代客户入口密码；两套秘密必须不同。[frp Basic Auth](https://gofrp.org/en/docs/features/http-https/auth/)、[连接器鉴权](https://gofrp.org/en/docs/features/common/authentication/)

### 7.3 VPS HTTPS

把 `accept.example.com` 的 A/AAAA 记录指向 VPS，Caddyfile：

```caddyfile
accept.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 在域名 DNS 正确且 80/443 可达时自动申请并续期证书。[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)

防火墙务必阻止公网直接访问 `8080`，否则会绕过 Caddy TLS；也不要把 frp token 或 Basic Auth 明文提交 Git。当前 SampleFlow 的 `APP_ORIGINS` 设置为 `https://accept.example.com`。

## 8. Docker Compose 云端备选

### 8.1 Railway：不能直接运行 Compose

确认事实：Railway 不直接运行 `docker-compose.yml`；要把每个 Compose service 映射成 Railway service，数据库宜替换为 managed Postgres，`depends_on` 没有直接等价物，服务应自行重试；服务间用 `<service>.railway.internal`，公网服务再 Generate Domain。[官方 Compose 指南](https://docs.railway.com/guides/docker-compose)

对当前仓库意味着：

- Web Dockerfile 和 API Dockerfile可分别构建；Postgres 改为 Railway Postgres。
- 现有 `apps/web/nginx.conf` 写死 `proxy_pass http://api:3000`，必须先改为 Railway 私网 hostname 或让模板从环境变量读取；未经该适配不能声称可直接部署。
- 首次 `db-provision-roles`、`db-migrate`、`admin-bootstrap` 要拆成批准的一次性任务；不能依赖 Compose profile。
- 只给 Web 生成公网域名；API 和数据库保持 private networking。
- `APP_ORIGINS=https://<web-domain>`；平台注入数据库变量；不要复制 `.env` 秘密到仓库。

价格确认：Free 当前 $0/月并给 $1/月信用；Hobby $5/月，订阅费计入资源用量；Free 单服务上限 0.5 GB RAM、0.5 GB volume。当前 Compose 给 PostgreSQL 配 1 GB，因此“整个项目永久免费且等同本地规格”没有依据。[Railway 价格](https://docs.railway.com/pricing/plans)

### 8.2 Render：用 Blueprint，不直接导入 Compose

Render 用 `render.yaml` Blueprint 管理多服务，并支持 Dockerfile、managed Postgres、private networking、health check 与 pre-deploy command。[Blueprint](https://render.com/docs/infrastructure-as-code)、[Docker on Render](https://render.com/docs/docker)

映射草图（**不是当前仓库可直接部署文件**）：

```yaml
services:
  - type: web
    name: sampleflow-web
    runtime: docker
    dockerfilePath: ./apps/web/Dockerfile
    healthCheckPath: /healthz
    envVars:
      - key: APP_ORIGINS
        value: https://<最终域名>

  - type: pserv
    name: sampleflow-api
    runtime: docker
    dockerfilePath: ./apps/api/Dockerfile
    healthCheckPath: /api/ready
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: sampleflow-db
          property: connectionString

databases:
  - name: sampleflow-db
```

仍需先适配 Web Nginx 的 API 私网 hostname、数据库角色初始化和迁移作业。Render 免费 Web 可以发起私网请求但不能接收私网请求，因此“两个免费 Web 服务用私网互连”不可行；API 要么成为付费 private service，要么公开为 Web service并承担额外安全/CORS 配置。[Render 私网限制](https://render.com/docs/private-network)

免费层适合预览而非正式生产：免费 Postgres 30 天到期，免费 Web 无 persistent disk，并存在休眠/免费小时和带宽限制。[Render 免费层](https://render.com/docs/free)

### 8.3 中国内地/香港轻量云：当前 Compose 最直接

这条路径最贴近仓库 ADR。腾讯云官方 Docker CE 轻量服务器说明确认可取得公网 IP、配置防火墙、域名和 HTTPS；域名指向中国内地服务器时必须 ICP 备案。[腾讯云官方文档](https://cloud.tencent.com/document/product/1207/60423)

Ubuntu 上按 [Docker 官方 apt 仓库说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine 与 Compose plugin：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
docker compose version
```

Docker 官方警告：容器发布端口可能绕过 `ufw`/`firewalld` 的常规规则，仍要同时核对云安全组和 Docker 防火墙链；不能仅凭 `ufw deny` 推断端口已关闭。核心部署命令与仓库 `docs/deployment.md` 相同：

```sh
git clone <批准的私有仓库地址> sampleflow
cd sampleflow
cp .env.example .env
chmod 600 .env
# 编辑 .env：WEB_BIND_ADDRESS=127.0.0.1、正式 Origin、四套不同数据库秘密、非 root UID/GID、绝对备份目录

docker compose build api web
docker compose up -d --wait db
docker compose --profile operations run --rm db-provision-roles
docker compose --profile operations run --rm db-migrate
docker compose --profile operations run --rm admin-bootstrap
docker compose up -d --wait api web
curl --fail http://127.0.0.1:8080/api/ready
```

再用 Caddy/Nginx 在 443 终止 HTTPS并只转发到 `127.0.0.1:8080`。云防火墙只开 80/443；SSH 仅允许管理 IP；不要开放 3000、5432、55432 或 8080。若无备案而客户主要在内地，香港节点常是较快落地的折中，但线路质量仍必须用客户实际运营商测试——这是工程推断，不是供应商保证。

## 9. 客户验收前检查清单

### 9.1 开发者侧

```powershell
$composeArgs = @('-p', 'sampleflow-acceptance', '--env-file', '.env.acceptance.local')
docker compose @composeArgs ps
curl.exe --fail http://127.0.0.1:18080/healthz
curl.exe --fail http://127.0.0.1:18080/api/ready
```

若入口尚未启用 Access/Basic Auth，可再用 `curl.exe --fail https://accept.example.com/api/ready` 检查端到端链路。启用外层认证后，该命令只会收到认证跳转/挑战，不能证明应用 ready；应使用批准邮箱在浏览器完成 Access 登录，再检查应用登录与关键流程。

- 公网入口只到 Web，公网扫描确认 3000、5432、55432 不可达。
- 使用独立验收数据库/数据副本，不让客户触达生产或本地真实业务数据。
- 创建最小权限验收账号；不要共享超级管理员。
- 确认浏览器 DevTools 无 mixed content、CORS、CSRF 或 Cookie 被拒警告。
- 测试登录、刷新后会话、写操作、退出、下载、Excel 上传（30 MB Nginx 上限）、大页面和长请求。
- Windows 禁止睡眠、自动重启和网络切换；保持 Docker Desktop、Compose 和隧道进程运行。
- 先让客户在其办公网络测试；再用手机热点对照。记录时间、运营商、URL、HTTP 状态和 request ID，不把响应正文/业务数据发到公共工单。

### 9.2 发给客户的最小信息

1. 唯一 HTTPS URL。
2. Access OTP 的批准邮箱，或 Basic Auth 用户名/密码（独立安全通道）。
3. SampleFlow 的低权限验收账号（与入口密码分开）。
4. 推荐 Chrome/Edge 当前稳定版，以及验收时间窗口。
5. 故障反馈只需时间、页面、动作、截图和 request ID；不要发送密码或完整敏感数据。

## 10. 常见问题排查

| 现象 | 优先检查 |
|---|---|
| 公网 502/Bad Gateway | `docker compose @composeArgs ps`；本机 `127.0.0.1:18080`；Tunnel/ngrok/frpc 日志；Windows 防火墙与代理软件 |
| `/api/ready` 503 | 数据库是否 healthy；是否执行 `db-provision-roles` 和 `db-migrate`；API 日志中的 `DB_UNAVAILABLE`/`SCHEMA_OUTDATED` |
| 登录返回 `ORIGIN_INVALID` | `APP_ORIGINS` 是否与浏览器地址栏的 scheme+host+port 完全一致；改 `.env.acceptance.local` 后 API 是否已重建/重启 |
| 登录成功但立即掉线 | 必须从 HTTPS URL 访问；确认 `NODE_ENV=production`；浏览器是否拒绝 Cookie；系统时间是否正确 |
| 写操作 `CSRF_INVALID` | 不要把前端和 API 分成不同域名；确认 `/api/auth/csrf`、Cookie 和请求头仍走同源入口 |
| Access OTP 收不到 | Access policy 是否精确包含邮箱；邮件网关是否允许 `notify.cloudflare.com`；重新申请，旧 PIN 会失效 |
| Access 重定向循环 | 检查浏览器第三方 Cookie/隐私拦截、应用域名范围和多域 Cookie 设置 |
| Quick Tunnel 429 | 触及 200 in-flight 限制；改 named Tunnel 或其他方案 |
| SSE 断开 | Quick Tunnel 官方明确不支持 SSE；改 named Tunnel。当前 SampleFlow 未发现验收必须使用 SSE |
| 客户内地网络间歇超时 | 用办公网络/手机热点、Cloudflare/ngrok/VPS 三条路径对照；若仅跨境方案失败，切香港/内地轻量云 |
| 上传失败/413 | 当前 Nginx `/api/` 为 30 MB；核对入口层和应用层是否有更小上限 |
| frp 可连但域名 404 | `customDomains`、DNS、Caddy Host 和 `vhostHTTPPort` 是否一致 |
| 云平台 API 访问失败 | 不要假设 Compose service name 在平台私网原样解析；使用平台实际 internal hostname并适配 Nginx |

## 11. 验收结束后的安全关闭

顺序应先切断公网入口，再停应用；保留验收证据但不保留秘密。

### Cloudflare Quick Tunnel / named Tunnel

```powershell
# 交互式进程按 Ctrl+C
Get-Process cloudflared -ErrorAction SilentlyContinue
```

- named Tunnel：先在 Access 禁用/删除应用策略或移除 public hostname/DNS route；确认公网 URL 不再到达 origin。
- 若曾把 connector 安装为 Windows service，再按 Dashboard/官方服务说明停用并卸载；不要盲目杀掉机器上其他 Tunnel。
- 删除本机 tunnel credentials 前先核对 UUID；凭据泄露则在 Cloudflare 控制台撤销/轮换。

### ngrok

```powershell
# 交互式进程按 Ctrl+C
Get-Process ngrok -ErrorAction SilentlyContinue
```

在 ngrok Dashboard 确认 endpoint offline；删除临时 Traffic Policy/保留域名绑定；若 token 曾外泄则立即轮换 authtoken。

### frp / VPS

```powershell
# Windows frpc 交互式进程按 Ctrl+C
Get-Process frpc -ErrorAction SilentlyContinue
```

VPS 先停 `frps`/Caddy入口，关闭安全组 7000/80/443，删除 DNS 记录，轮换/撤销 frp token 和 Basic Auth。若只是暂停，不删除 VPS 数据盘；如要销毁实例，先按批准流程备份并核验，销毁属于单独的不可逆操作。

### 本地/云端 Compose

```powershell
$composeArgs = @('-p', 'sampleflow-acceptance', '--env-file', '.env.acceptance.local')
docker compose @composeArgs stop web api
docker compose @composeArgs down
```

`down` 会停止并移除该验收项目的容器与网络，但保留命名数据库卷。不要执行 `docker compose down -v`、`docker system prune` 或删除 `.sampleflow`；这些可能删除数据库卷或备份。验收账号应禁用/撤销会话，临时入口密码和分享记录应清理。是否停数据库、备份或销毁云资源，应单独确认数据保留要求。

## 12. 最终推荐的直接执行路径

若已有 Cloudflare 域名：

1. Compose 只把 Web 映射到 `127.0.0.1:18080`。
2. `APP_ORIGINS=https://accept.example.com`，生产模式启动。
3. 建 named Tunnel，将 `accept.example.com` 指向 `http://127.0.0.1:18080`。
4. Access 只允许客户具体邮箱 + OTP。
5. 客户真实网络预演一遍；失败则保留同一 Compose，切换 ngrok 或香港/内地轻量云入口。

若没有域名且当天就要验收：先用 Quick Tunnel 做技术预演；涉及敏感数据或正式客户验收时改用 ngrok Basic Auth，或购买一个亚洲 VPS/域名。不要为了公网访问拆分前后端入口，也不要暴露数据库。
