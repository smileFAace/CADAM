# 架构分析与改进计划

## 一、问题清单

### 1.1 单体工具调用（Monolithic Tool Call）

**问题：** `build_parametric_model` 是一个单体工具，模型每次调用都要生成数百行完整 OpenSCAD 代码，缺少逐步构建的中间反馈机制。

**详见：** `toolcall-architecture.md`

---

### 1.2 滑块调整不回写（Parameter Sync Gap）

**问题：** 用户调整右侧参数面板的滑块后，修改后的代码仅用于本地预览，**不写回对话历史**，因此下次 LLM 调用时看到的仍是原始代码。

**当前链路：**

```
LLM 生成代码（含参数声明）
       ↓
baseCodeRef ← artifact.code（原始代码）
       ↓
用户拖滑块 → updateParameter(code, param) → 本地编译 → 预览更新
       ↓          ↓
  baseCodeRef 不变  conversation.parts 不变
       ↓
下次对话 → LLM 读到原始代码 → 与滑块状态不一致
```

**原因：**
- `replaceBuildParametricModelOutput()` 函数在 `shared/parametricParts.ts` 中已定义，但**从未在代码库任何地方被调用**
- `persistAssistantParts()` 仅在 tool call 返回结果时调用，滑块调整不触发

**影响：**
- 用户拖滑块改了尺寸 → 再让 LLM "加个把手" → LLM 用原始尺寸生成把手，不匹配
- 用户拖滑块改了颜色 → LLM 不知道，可能用旧颜色命名生成后续代码

**修复方案：**
在 `EditorView.tsx` 的 `changeParameters` 回调中，追加持久化逻辑：

```typescript
const changeParameters = useCallback(
  (nextParameters: Parameter[]) => {
    let nextCode = baseCodeRef.current;
    for (const parameter of nextParameters) {
      nextCode = updateParameter(nextCode, parameter);
    }
    setParameters(nextParameters);
    setActivePreview({ ...activePreview, artifact: { ...activePreview.artifact, code: nextCode } });

    // ≈ 新增 ≈ 将修改后的代码写回对话历史
    if (activePreview?.type === 'artifact') {
      const parts = replaceBuildParametricModelOutput(
        currentParts,       // 当前对话的 parts
        { ...activePreview.artifact, code: nextCode },
      );
      persistAssistantParts({
        conversationId: conversation.id,
        messageId: activePreview.messageId,
        parts,
      });
    }
  },
  [activePreview],
);
```

**所需函数（均已存在）：**
- `updateParameter(code, param)` — `src/lib/utils.ts`
- `replaceBuildParametricModelOutput(parts, artifact)` — `shared/parametricParts.ts`（当前死代码）
- `persistAssistantParts({ conversationId, messageId, parts })` — `src/services/messageService.ts`

---

### 1.3 上下文窗口膨胀（Context Window Bloat）

**问题：** 每次模型生成一个 `build_parametric_model` tool call，其 `input.code` 包含数百行 OpenSCAD 代码。这些代码保留在对话历史中，随着迭代次数增加，上下文窗口被大量代码填充。

| 轮次 | 上下文内容 | Token 消耗 |
|------|-----------|-----------|
| 第 1 轮 | system prompt + 用户输入 + 300 行代码 | ~2,000 |
| 第 2 轮 | ↑ + 上一轮 300 行 + 新 300 行 | ~3,300 |
| 第 5 轮 | ↑ 累积 + 5×300 行代码 | ~5,000+ |

**场景图方案**通过维护服务端状态而不是历史消息来解决这个问题——模型只发送增量操作，不需要每次都重发全部代码。

---

## 二、改进计划路线图

```
Phase 1（即日）:
  修复滑块不回写问题
  - 在 changeParameters 中调用 persistAssistantParts
  - 启用 replaceBuildParametricModelOutput
  改动量：~10 行，仅依赖已有函数

Phase 2（短期）:
  实现场景图存储
  - sceneGraph/types.ts — 节点类型定义
  - sceneGraph/store.ts — 内存场景图（每会话一个）
  - sceneGraph/toScad.ts — 场景图 → OpenSCAD 代码生成器
  改动量：~300-500 行新代码

Phase 3（中期）:
  实现原子工具集
  - declare_parameter
  - create_primitive
  - apply_transform
  - apply_boolean
  - render_preview
  - finalize
  替换单体 build_parametric_model

Phase 4（长期）:
  增量编译与渐进式预览
  - 缓存中间编译结果
  - 只重新编译变更节点
  - 用户可以看到模型一步步生长
```

---

## 📌 更新日志

| 日期 | 更新内容 |
|------|----------|
| 2026-05-21 | 初版 — 记录三大问题：单体 tool call、滑块不回写、上下文膨胀 |

---

_更新时间：2026-05-21_
