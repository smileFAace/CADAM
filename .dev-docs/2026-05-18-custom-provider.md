# 2026-05-18 自定义 Provider 配置开发记录

## 目标

为 CADAM 添加自定义 LLM Provider 支持，实现：

- 后端作为模型配置的唯一数据源（SSOT）
- 前端通过 API 获取模型列表
- 通过 `providers.local.json` 配置文件驱动，无需修改源码

## 实现方案

### 架构设计

```
后端 (SSOT)                        前端 (消费者)
───────────────                    ──────────
providers.local.json               ↓
       ↓                           useModels() hook
  src/server/models.ts             ↓
  ┌─────────────────┐              下拉框显示模型
  │ getModels()     │ ── API ──→
  │ resolveCustom() │
  └─────────────────┘
       ↓
  resolveModel()
  实际调用 API
```

### 关键文件

| 文件                           | 作用                     |
| ------------------------------ | ------------------------ |
| `src/server/models.ts`         | 模型配置加载、单一数据源 |
| `src/server/parametricChat.ts` | API 端点、模型解析       |
| `src/hooks/useModels.ts`       | 前端 hook，获取模型列表  |
| `providers.local.json`         | 配置文件（不提交到 git） |

### API 端点

```
GET /cadam/api/parametric-chat?action=getModels
```

返回所有可用模型（内置 + 自定义）。

### 配置文件格式

```json
{
  "builtinModels": [...],  // 可选，覆盖默认内置模型
  "providers": [
    {
      "id": "xiaomi",
      "name": "Xiaomi MiMo",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-xxx",
      "models": [
        {
          "id": "openai/gpt-5.5",      // 匹配前端选择的模型 ID
          "apiModelId": "mimo-v2.5-pro", // 实际调用的模型 ID
          "name": "MiMo V2.5 Pro",
          "supportsTools": true,
          "supportsThinking": true
        }
      ]
    }
  ]
}
```

## 遇到的问题

### 1. 前后端模型列表重复

**问题**：`PARAMETRIC_MODELS` 在前端 `utils.ts` 中写死，后端也需要同样的列表。

**解决**：后端作为 SSOT，前端通过 API 获取。

### 2. TanStack Router 路由限制

**问题**：添加新的 API 路由需要修改自动生成的 `routeTree.gen.ts`，非常麻烦。

**解决**：复用现有路由 `/api/parametric-chat`，通过 `?action=getModels` 参数区分。

### 3. Node.js 模块在浏览器端报错

**问题**：`customProviders.ts` 使用了 `fs` 模块，但被前端代码导入。

**解决**：将文件操作全部移到 `src/server/models.ts`（纯后端模块）。

### 4. JSON 解析失败（⚠️ 待解决）

**问题**：MiMo 模型返回的 JSON 格式不规范：

- 被 markdown 代码块包裹（`json ... `）
- 字符串中的双引号未转义（`"#2A7B9B"` 破坏 JSON 结构）

**当前缓解措施**：

- 剥离 markdown 代码块
- 添加 `fixJsonEscaping()` 函数修复转义

**根本问题**：要求 LLM 返回一大段正确 JSON 本身就是脆弱的设计。

## 后续优化方向

### 方案 A：使用 Tool Calling（推荐）

让模型通过 tool calling 返回结构化数据，而不是直接生成 JSON：

```typescript
const result = await generateText({
  model: ...,
  tools: {
    create_openscad_model: tool({
      parameters: z.object({
        code: z.string(),
        parameters: z.array(z.object({...})),
      }),
      execute: async (params) => params,
    }),
  },
});
```

**优点**：LLM 擅长 tool calling，JSON 由 SDK 自动处理。

### 方案 B：只返回代码

修改 prompt 让模型只返回 OpenSCAD 代码，后端用 `parseParameters()` 提取参数：

```typescript
// 修改 STRICT_CODE_PROMPT，只要求返回代码
// 使用 artifactFromLegacyCode() 处理输出
```

**优点**：最简单，避免 JSON 解析问题。

### 方案 C：多次 Tool Call 生成

将复杂模型拆分为多次 tool call：

1. 第一次：生成基础结构和参数
2. 第二次：生成各个 part 的代码
3. 后端组装最终结果

**优点**：降低单次生成复杂度，提高成功率。

## Git 提交记录

```
d3534db feat: SSOT model config - server owns model list, frontend fetches via API
```

## 测试状态

- ✅ 编译通过
- ✅ 前端显示自定义模型
- ⚠️ JSON 解析偶尔失败（需要后续优化）
