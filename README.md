# 面证 · 一个盯住面试证据的 Agent

招聘链路里只做一段：**面试 → 评估**。它给面试官一份已经挂好候选人原话的草稿，把找不到证据的维度标成缺口、带到下一轮；分数、提交、录用都由人做。

## 先看什么

| 文件 | 是什么 |
|---|---|
| [`docs/面证-笔试方案.md`](docs/面证-笔试方案.md) | **作业正文**：六个问题逐条作答，从用户与切入点、核心功能、取舍、核心流程，到怎么验证、AI 使用过程 |
| [`docs/面证-PRD.md`](docs/面证-PRD.md) | **PRD（评审稿）**：范围、流程、字段、异常、AI 能力、接口、验收标准、指标 |
| [`docs/面证-痛点调研.md`](docs/面证-痛点调研.md) | 痛点调研与来源清单 |
| [`docs/演示步骤与脚本.md`](docs/演示步骤与脚本.md) | 现场演示的点击顺序与口播（约 6 分钟） |
| 方案 §8.3 | 提交视频用的 3 分钟出镜提纲（不写逐字稿） |

## 作业六问 → 在哪一节

| 问题 | 章节 |
|---|---|
| 用户与切入点 | §0 一页纸、§1（1.1 角色与登录频次、1.2 为什么是这一段、1.3 为什么不是只服务 HR） |
| 核心功能 | §2（定标、一页纸、面评，以及两张给 HR 的清单） |
| 取舍 | §3（三个「看起来必须做」但不做；五个先砍的工程；48h 升级砍成一次提醒） |
| 核心流程 | §4（4.1 一个维度的真实走法、4.2 人和 Agent 逐步骤分工、4.3/4.4 边界） |
| 怎么证明它有用 | §5（三个必须先回答的问题、试点设计、指标、停手线） |
| AI 使用过程说明 | §6（关键节点时间线、帮到的地方、看似合理但不成立的建议、怎么识别和修正） |

## 跑起来看（不需要任何密钥）

需要 Node 22 以上（用到 `node:sqlite`）。

```bat
cd /d <项目目录>
set MIANYAN_DEMO_MODE=1
set MIANYAN_DB_PATH=data/demo.db
npm install
npm run seed
npm run dev
```

浏览器打开 `http://localhost:5173`。三个演示账号，密码都是 `mianzheng2026`：

| 角色 | 邮箱 |
|---|---|
| 招聘负责人（HR） | `hr@demo.mianzheng.local` |
| 面试官 | `wang@demo.mianzheng.local` |
| 用人经理 | `zhao@demo.mianzheng.local` |

`MIANYAN_DEMO_MODE=1` 是显式开关：语言模型与转写都用本地模拟，不联网；正常启动时缺服务会直接报错，不会偷偷换成假实现（见 `apps/server/src/build.ts`）。

想看真实模型效果，复制 `.env.example` 为 `.env`，填 `MIANYAN_LLM_API_KEY`（任何 OpenAI 兼容服务，默认 LongCat）和转写配置，去掉 `MIANYAN_DEMO_MODE` 即可。`.env` 不会随包提交。

## 部署（前端 Vercel + 后端 Render）

**为什么不全部放 Vercel**：Vercel 的函数是无状态的，只有 `/tmp`，实例之间不共享。这个产品的登录会话和面评都写在 SQLite 里，纯 Vercel 会出现「随机掉登录、数据重置」。所以 Vercel 只放静态页面，再加一个 `/api` 转发函数；真正的进程和数据库在 Render。

### 0. 部署顺序（先 Render，后 Vercel）

1. **Render**：New → Blueprint → 选这个仓库 → 应用 `render.yaml` → Deploy。等镜像构建完，拿到地址（形如 `https://mianzheng-api.onrender.com`）。
2. **验后端**：浏览器打开 `<后端地址>/auth/me`，返回 401 `auth_required` 就说明服务活着。
3. **Vercel**：Add New → Project → 导入同一个仓库 → 环境变量加 `API_ORIGIN = <后端地址>` → Deploy。
4. **验整体**：打开 Vercel 域名，用 `hr@demo.mianzheng.local / mianzheng2026` 登录，能进「候选人结果」就通了。

### 1. 后端（Render）

- 默认走**免费档**：不用绑卡，适合今天交作业；代价是容器休眠/重启后 `/data` 会重置，第一次启动会自动重新 seed，**评审提交的数据不会跨重启保留**。
- 需要持久化就改成 `plan: starter`（约 $7/月），并在 `render.yaml` 加回磁盘：

```yaml
    plan: starter
    disk:
      name: mianzheng-data
      mountPath: /data
      sizeGB: 1
```

- 免费档冷启动要约 50 秒；第一次打开慢是正常的。Vercel 转发函数的超时已设成 60 秒。

### 2. 前端（Vercel）

1. 框架选 **Other**（构建命令和输出目录已写在 `vercel.json`，输出 `apps/web/dist`）。
2. 环境变量：`API_ORIGIN = https://<后端地址>`（不要带 `/api`）。
3. 部署后访问 Vercel 域名：页面是静态的，`/api/*` 由 `vercel.json` 重写到 `api/proxy.js`，再转发到 Render；浏览器看到的始终是同一个域名，登录 Cookie 正常。

### 3. 本地验证转发（可选）

```bat
set API_ORIGIN=http://127.0.0.1:8787
node scripts/serve-proxy.mjs
```

然后访问 `http://127.0.0.1:8891`，行为和线上一致。

## 原型是什么、不是什么

**是**：可运行的原型；真实登录与会话（口令散列、服务端会话、失败锁定）；Agent 运行时（目标、循环、工具、暂停恢复、步数预算、重复保护、审计）；证据账本；三道人工闸门（签标准、认证据、提交面评）；交付看板与候选人结果屏。本地验证：117 个测试、8 个测试文件全过，TypeScript 两套 0 错误，生产构建可用。

**不是**：真实 ATS 集成、客户验证、生产级安全（没做渗透测试，没有等保）。演示库用固定时钟与模拟模型，**不要放真实候选人数据**。

## 打包提交时不要带

- `.env`（含 API key）、`node_modules/`、`data/*.db`、`.tsbuild/`、`.quarantine/`
- `Ollama/`、`vibe_images/`（本地素材，未纳入 `.gitignore`，需要手动排除）

包里保留：源码、`docs/`、`.env.example`、`package.json` 与 lockfile。
