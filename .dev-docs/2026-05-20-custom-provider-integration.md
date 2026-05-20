# 2026-05-20 Custom Provider 集成问题记录

## 概述

为 CADAM 添加自定义 LLM Provider 支持，允许通过 `providers.local.json` 配置文件接入 OpenAI-compatible 和 Anthropic-compatible 的第三方模型服务。

## 解决的问题

### 1. 数据库 Schema 不同步

**现象**：

```
Could not find the 'metadata' column of 'messages' in the schema cache
```

**根因**：本地 Supabase 数据库 schema 太旧，`messages` 表缺少 `metadata` 列。当前 `master` 分支的代码已经依赖新的 `parts` + `metadata` 消息结构，但本地数据库没有应用对应的 migration。

**解决**：执行 `npx supabase db reset`，重跑所有 migration。

---

### 2. 自定义 Provider 协议族判断错误

**现象**：

- 用 `@ai-sdk/openai` 发请求 → `Param Incorrect`
- 用 `@ai-sdk/anthropic` 发请求 → `Not Found`

**根因**：不同 provider 的"兼容"程度不同。Xiaomi MiMo Token Plan 虽然 URL 像 OpenAI，但实际对请求格式有特殊要求。直接套用任一 SDK 都会失败。

**解决**：引入 `apiType` 配置字段，让配置文件声明 provider 使用的协议族：

- `openai` → `@ai-sdk/openai`
- `anthropic` → `@ai-sdk/anthropic`

---

### 3. Xiaomi MiMo 的 `reasoning_content` 要求

**现象**：

```json
{
  "error": {
    "code": "400",
    "message": "Param Incorrect",
    "param": "The reasoning_content in the thinking mode must be passed back to the API."
  }
}
```

**根因**：MiMo 在回复中自动开启 thinking mode，replay 对话历史时必须把 `reasoning_content` 字段带回去。Turn 1 成功，Turn 2 失败。

**解决**：参考 pi 的 `requiresReasoningContentOnAssistantMessages` compat 配置，在 custom openai fetch middleware 中自动给 replay 的 assistant 消息补上 `reasoning_content: ''`。

---

### 4. `stream_options` 和 `tool_choice` 不兼容

**现象**：`Param Incorrect`，但无法确定具体是哪个字段导致。

**根因**：很多 OpenAI-compatible provider 不支持：

- `stream_options: { include_usage: true }`
- `tool_choice: "auto"`

**解决**：参考 pi 的 compat 体系，新增两个配置字段：

- `supportsUsageInStreaming: false` → 删除 `stream_options`
- `supportsToolChoice: false` → 删除 `tool_choice`

---

### 5. `max_completion_tokens` vs `max_tokens`

**现象**：某些 provider 不认识 `max_completion_tokens` 字段。

**根因**：AI SDK 默认使用 `max_completion_tokens`，但很多 OpenAI-compatible provider 只认 `max_tokens`。

**解决**：参考 pi 的 `maxTokensField` compat 配置，在 fetch middleware 中自动将 `max_completion_tokens` 改写为 `max_tokens`。

---

### 6. 模型 ID 双重身份问题

**现象**：配置文件中同时有 `id` 和 `apiModelId`，导致信息来源不一致。

**根因**：旧设计中 `id` 是 CADAM 内部 ID，`apiModelId` 是实际调用的模型名。两者可能不同（如 `id: "openai/gpt-5.5"` 但 `apiModelId: "mimo-v2.5-pro"`），容易混淆。

**解决**：配置文件中只保留 `apiModelId` 作为唯一模型标识。内部运行时自动派生 `id = apiModelId`，保持前端类型兼容。

---

### 7. `supabase` CLI 命令不可用

**现象**：`supabase: command not found`

**解决**：使用 `npx supabase` 代替直接调用 `supabase`。

---

## 设计决策

### 为什么选择 fetch middleware 而不是修改 AI SDK

CADAM 使用 `@ai-sdk/openai` SDK，该 SDK 的 `createOpenAI` 支持自定义 `fetch` 函数。通过注入自定义 fetch，可以在请求发出前拦截并改写 body，实现：

- 字段重命名（`max_completion_tokens` → `max_tokens`）
- 字段删除（`stream_options`、`tool_choice`）
- 字段注入（`reasoning_content`）
- Role 降级（`developer` → `system`）

这种方式不需要 fork AI SDK，也不影响内置 provider 的行为。

### 为什么保留 `providers.local.json` 而不是用环境变量

- 配置文件更直观，支持多个 provider 和多个模型
- 可以在不修改代码的情况下切换 provider
- 兼容 pi 的配置理念（`models.json`）

---

## 测试验证

### 直接 API 测试（scripts/test-custom-provider.mjs）

- 直接调用 provider API，验证请求/响应格式
- 用于快速定位协议层问题

### AI SDK 路径测试（scripts/test-custom-provider-via-sdk.ts）

- 使用与 CADAM `aiChat.ts` 相同的代码路径
- 验证 `resolveCustomProvider()` → `createOpenAI()` → `createOpenAICompatFetch()` → `generateText()` 完整流程
- 模拟两轮对话：Turn 1 创建正方体 → Turn 2 添加圆柱体

### 测试结果

| Provider                    | Turn 1            | Turn 2            |
| --------------------------- | ----------------- | ----------------- |
| Xiaomi MiMo (mimo-v2.5-pro) | ✅ 33 行 OpenSCAD | ✅ 46 行 OpenSCAD |
| RunAnyTime DeepSeek V4 Pro  | ✅ tool call      | ✅ tool call      |

---

## 配置示例

```json
{
  "providers": [
    {
      "id": "xiaomi",
      "name": "Xiaomi MiMo",
      "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
      "apiKey": "YOUR_KEY",
      "apiType": "openai",
      "compat": {
        "requiresReasoningContentOnAssistantMessages": true,
        "maxTokensField": "max_tokens",
        "supportsUsageInStreaming": false,
        "supportsToolChoice": false
      },
      "models": [
        {
          "apiModelId": "mimo-v2.5-pro",
          "name": "MiMo V2.5 Pro",
          "supportsTools": true,
          "supportsThinking": true,
          "supportsVision": false
        }
      ]
    }
  ]
}
```

---

## 参考来源

- pi 的 `docs/custom-provider.md`：compat 配置体系
- pi 的 `node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js`：具体兼容逻辑
- pi 的 `~/.pi/agent/models.json`：Xiaomi MiMo 的实际配置（`api: "openai-completions"` + `compat`）
