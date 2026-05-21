# 初始化工作流

> 每次拉取最新代码后，按此流程完整初始化本地开发环境。

---

## 📋 初始化流程

### 1. 拉取最新代码

```bash
# 切换到目标分支（根据实际分支名称调整）
git checkout custom-provider

# 拉取最新代码
git pull origin custom-provider
```

> ⚠️ 如果本地有未提交的改动，先 stash：
>
> ```bash
> git stash push -m "描述"
> ```
>
> 切换分支后再恢复：`git stash pop`

### 2. 安装依赖

```bash
npm install
```

> ⚠️ `package-lock.json` 可能因跨平台（Linux/WSL/Windows）产生差异，在切换分支时会被 Git 检测到未暂存的更改。这是正常的，stash 后切换分支即可。

### 3. 编译项目

```bash
npm run build
```

**构建内容：**

- 🔹 **SSR 客户端** — Vite 构建浏览器端资源
- 🔹 **SSR 服务端** — 服务端渲染代码
- 🔹 **Nitro 服务端** — Node.js 服务端部署包（输出到 `.output/`）
- 🔹 **预渲染** — 静态页面预渲染（如 `/cadam`）

**构建耗时参考：** 约 2-3 分钟（取决于机器性能）

**常见 warning（无影响）：**

- `eval` in `lottie-web` — 第三方依赖，无法避免
- `No auth token` (Sentry) — 本地开发不需要
- 某些 chunks > 1000 kB — 体积警告，不影响功能

### 4. 重置本地 Supabase 数据库

代码更新可能包含新的迁移文件，需要重置本地数据库使其 schema 与最新代码一致。

```bash
# 方法一：直接重置（推荐）
npx supabase db reset

# 方法二：停掉再启动（如果方法一报 502 或其他错误）
npx supabase stop --no-backup
npx supabase start
```

**重置过程：**

1. 删除并重建本地数据库
2. 依次应用所有迁移文件（`supabase/migrations/` 下所有 `.sql`）
3. 执行 `seed.sql` 填充测试数据
4. 启动所有容器（数据库、Auth、Storage、Studio 等）

> ⚠️ **`db reset` 会清空所有本地数据**，仅保留 `seed.sql` 中定义的数据。如果有需要保留的测试数据，请先备份。

**耗时参考：** 约 1-3 分钟（首次可能需要拉取容器镜像，会更久）

**常见问题：**
| 问题 | 原因 | 解决 |
|------|------|------|
| `Error 502` | 容器重启时临时性错误 | `supabase stop --no-backup && supabase start` |
| 卡在 "Pulling logflare" | 首次需要拉取 Docker 镜像 | 等待完成即可，后续启动会快很多 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_SECRET` 未设置 | 本地开发不需要 Google OAuth | 不影响功能，只是 warning |

### 5. 验证

```bash
# 检查 supabase 状态
npx supabase status
```

**正常输出示例：**

```
API URL:         http://127.0.0.1:54321
DB URL:          postgresql://postgres:postgres@127.0.0.1:54322/postgres
Studio URL:      http://127.0.0.1:54323
Inbucket URL:    http://127.0.0.1:54324
```

---

## 🔄 完整命令速查

```bash
# ===== 一键初始化（按顺序执行） =====

# 1. 拉取代码
git checkout custom-provider && git pull origin custom-provider

# 2. 安装依赖
npm install

# 3. 编译
npm run build

# 4. 重置数据库
npx supabase db reset || (npx supabase stop --no-backup && npx supabase start)
```

---

## ⚠️ 注意事项汇总

### 🔸 代码相关

1. **分支切换前先 stash**：`package-lock.json` 等文件可能在 Windows 上产生差异
2. **不要跳过 build**：直接 `npm run dev` 可能因旧构建缓存导致奇怪的问题

### 🔸 Supabase 相关

1. **数据会丢失**：`db reset` 清空所有本地数据，`seed.sql` 是唯一的数据来源
2. **Docker 依赖**：Supabase 本地开发需要 Docker Desktop 运行中
3. **环境变量**：部分 warning（如 `GOOGLE_CLIENT_ID`）可忽略
4. **迁移顺序**：迁移按文件名排序依次执行，不要手动修改已有的迁移文件
5. **首次启动慢**：首次需要拉取多个 Docker 镜像（postgres、logflare、studio、gotrue 等），约需 5-10 分钟
6. **容器可能被删除**：如果遇到 `ECONNREFUSED 127.0.0.1:54321`，说明容器已丢失。直接 `npx supabase start` 重新创建即可，迁移会自动重新应用
7. **容器名冲突**：如果 `supabase start` 报 `container name already in use`，用 `docker rm -f supabase_*_cadam` 清理旧容器后再启动

### 🔸 构建相关

1. **Sentry warning**：没有 Sentry token 不影响本地开发
2. **chunk 体积警告**：不影响功能，Chrome DevTools 中可忽略
3. **准备好 Node.js**：package.json 中声明 `node ^20.19.0 || >=22.12.0`

---

## 📌 更新日志

| 日期       | 更新内容                                                               |
| ---------- | ---------------------------------------------------------------------- |
| 2026-05-21 | 初版 — 分支拉取 → 安装 → 编译 → Supabase 重置完整流程                  |
| 2026-05-21 | 重构：统一所有 LLM 调用入口为 `buildChatModel`，辅助功能（标题/建议/prompt）不再直接依赖具体 Provider |

---

_更新时间：2026-05-21_
