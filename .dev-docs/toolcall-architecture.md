# 工具调用（Tool Call）架构设计

> 本文档分析当前 `build_parametric_model` 单体工具的局限性，并设计一套逐步构建的原子化工具调用方案。

---

## 一、现状分析

### 当前架构

```
用户请求 → [单体工具] build_parametric_model({ code: "完整 OpenSCAD..." })
                                        │
                                        ├─ 编译 → 成功 → 返回预览
                                        │
                                        └─ 编译 → 失败 → 模型再次全量重写
```

**暴露的问题：**

| 问题 | 具体表现 |
|------|----------|
| **一次性生成** | 模型必须在一个 tool call 中生成数百行完整 OpenSCAD 代码 |
| **无中间反馈** | 编译之前，没有任何中间步骤可供验证或展示 |
| **错误恢复成本高** | 编译失败后模型需全量重写，而非局部修复 |
| **不可观察** | 用户看不到模型逐步构建过程，只能看到"转圈→出结果" |
| **模型认知过载** | 一次性处理所有几何、参数、布局、颜色，超出模型上下文的有效注意力范围 |

### 本质原因

`build_parametric_model` 不是一个真正的「工具调用」，它只是一个 **"把代码塞进编译器的管道"**。它没有利用 tool call 架构最核心的能力——**将复杂任务拆解为原子步骤，每步可观测、可验证、可回溯**。

---

## 二、目标架构

### 核心概念：场景图（Scene Graph）

服务端维护一个 **CSG 树形场景图**，记录每一步创建的形状、变换和布尔运算。每个 tool call 操作这个场景图的一个节点，`preview` 调用时遍历全图生成 OpenSCAD 代码并编译。

```
场景图（示例：一个杯子）

Root (union)
├── Shape: Cylinder (body)     ← { height: 100, radius: 40 }
│   └── Param: body_height     ← { default: 100, range: [50, 200] }
│   └── Param: body_radius     ← { default: 40, range: [20, 80] }
├── Shape: Torus (handle)      ← { major_r: 30, minor_r: 5 }
│   └── Transform: translate   ← { x: 35, z: 50 }
│   └── Param: handle_size     ← { default: 30, range: [15, 60] }
└── Operation: difference (hollow)
    └── Shape: Cylinder (inner) ← { height: 97, radius: 37 }
```

### 逐步构建流程

```
用户: "做一个杯子"

  Step 1: declare_parameter({ name: "cup_height", type: "slider", default: 100, range: [50,200] })
          → { param_id: "p1" }

  Step 2: create_primitive({ type: "cylinder", params: { h: "$cup_height", r: 40 } })
          → { shape_id: "s1", preview_url: "..." }  ← 可以看到一个圆柱

  Step 3: declare_parameter({ name: "wall_thickness", type: "slider", default: 3, range: [1,8] })
          → { param_id: "p2" }

  Step 4: create_primitive({ type: "cylinder", params: { h: "$cup_height", r: "$cup_height-$wall_thickness" } })
          → { shape_id: "s2" }

  Step 5: apply_boolean({ operation: "difference", target: "s1", tool: "s2" })
          → { shape_id: "s3", preview_url: "..." }  ← 可以看到杯壁

  Step 6: create_primitive({ type: "torus", params: { r: 30, r2: 5 } })
          → { shape_id: "s4" }

  Step 7: apply_transform({ target: "s4", translate: { x: 35, z: 50 } })
          → { shape_id: "s5", preview_url: "..." }  ← 可以看到把手

  Step 8: apply_boolean({ operation: "union", target: "s3", tool: "s5" })
          → { shape_id: "s6", preview_url: "..." }  ← 完整的杯子

  Step 9: finalize({ root: "s6", title: "杯子" })
          → { status: "success", code: "生成完整 SCAD..." }
```

每一行 tool call 返回时，用户都能看到当前模型状态——**模型在一步步搭建，用户在一帧帧观察**。

---

## 三、工具定义

### Tool 1: `declare_parameter`

为模型声明一个可调参数。参数存储于场景图的参数表中，后续形状可以通过 `$param_name` 引用。

```typescript
declare_parameter({
  name: string,           // 参数名（snake_case）
  type: "slider" | "enum" | "boolean" | "string" | "color",
  default: number | string | boolean,
  range?: [min, max, step],     // slider 专用
  options?: string[],           // enum 专用
  description?: string,         // UI 提示文本
  group?: string,               // 分组标记，如 "Body" / "Handle"
})
→ { param_id: string }
```

### Tool 2: `create_primitive`

创建一个基本几何体。返回 `shape_id` 供后续工具引用。

```typescript
create_primitive({
  type: "cube" | "sphere" | "cylinder" | "cone" | "torus" | "polygon" | "text",
  params: Record<string, number | string>,   // 形状特有参数
  // cube:   { size, center? }
  // sphere: { r }
  // cylinder: { h, r, r1?, r2?, center? }
  // cone:   { h, r1, r2 }
  // torus:  { r, r2 }
  color?: string,            // CSS 颜色名或 hex
})
→ { shape_id: string, preview_url?: string }
```

### Tool 3: `apply_transform`

对已有形状施加变换（平移、旋转、缩放）。每次变换产生一个新的 `shape_id`。

```typescript
apply_transform({
  target: string,           // shape_id
  translate?: { x, y, z },
  rotate?:    { x, y, z },  // 角度
  scale?:     { x, y, z },
})
→ { shape_id: string, preview_url?: string }
```

### Tool 4: `apply_boolean`

对两个形状执行布尔运算。是 CSG 的核心操作。

```typescript
apply_boolean({
  operation: "union" | "difference" | "intersection",
  target: string,          // 主形状 shape_id
  tool: string,            // 工具形状 shape_id
})
→ { shape_id: string, preview_url?: string }
```

### Tool 5: `import_stl`

导入用户上传的 STL 模型作为场景中的一个形状。

```typescript
import_stl({
  filename: string,         // 用户上传的文件名
  rotation?: { x, y, z },  // 调整朝向
})
→ { shape_id: string, preview_url?: string }
```

### Tool 6: `render_preview`

编译当前场景图并返回预览。模型可以在关键步骤后主动调用，确认当前状态。

```typescript
render_preview()
→ { preview_url: string, current_code: string }
```

### Tool 7: `create_module`

将当前场景图的子集封装为可复用的 OpenSCAD module。用于重复结构。

```typescript
create_module({
  shapes: string[],         // 子 shape_id 列表
  name: string,             // module 名
  params?: string[],        // 暴露为 module 参数
})
→ { module_id: string }
```

### Tool 8: `finalize`

完成模型。服务端遍历场景图生成完整的 OpenSCAD 代码，包含所有参数声明和 Customizer 注释。

```typescript
finalize({
  root: string,             // 根 shape_id
  title: string,            // 模型名称
  version?: string,         // 版本号
})
→ {
  status: "success",
  code: string,             // 完整 OpenSCAD
  preview_url: string,
  parameters: Parameter[],  // 自定义参数列表
}
```

---

## 四、架构变更

### 新增组件

```
src/server/
├── sceneGraph/
│   ├── types.ts            # ShapeNode, ParamDef, etc.
│   ├── store.ts            # 场景图存储（内存，每个会话一个）
│   ├── toScad.ts           # 场景图 → OpenSCAD 代码生成器
│   └── buildTools.ts       # 工具实现（操作场景图）
├── aiChat.ts               # 修改：替换 tools 定义
```

### 数据流

```
模型 → tool call
       │
       ├─ declare_parameter → store.addParam(...)
       ├─ create_primitive  → store.addShape(node) → toScad(node) → compile
       ├─ apply_boolean     → store.addShape(booleanNode) → toScad(node) → compile
       └─ finalize          → toScad(root) → 生成完整 SCAD

场景图存储（每个 conversation 一个实例）
  params: Map<param_id, ParamDef>
  shapes: Map<shape_id, ShapeNode>
  root: shape_id | null       ← 指向最终的根节点
```

### 关键实现要点

1. **渲染性能**：每次 `create_primitive` / `apply_boolean` 后都需要编译并返回预览。对于复杂模型，可使用增量编译或缓存中间结果。
2. **场景图 → SCAD 代码生成**：`toScad.ts` 需要递归遍历场景图，生成正确的 OpenSCAD 语法，包括：
   - 参数声明 + Customizer 注释
   - `union()` / `difference()` / `intersection()` 包装
   - `translate()` / `rotate()` / `scale()` 变换
   - `color()` 包裹
   - `module` 定义与调用
   - `import()` 引用
3. **错误恢复**：如果某一步的编译失败（例如布尔操作的两个形状不相交），该步不创建新节点，模型可以重新调用。
4. **撤销能力**：场景图本身是 append-only 的，可以通过清除最后一个节点实现"上一步"。

---

## 五、与当前架构的对比

| 维度 | 当前（单体 tool） | 目标（原子 tool） |
|------|-------------------|-------------------|
| **工具数量** | 1 个 | 6-8 个 |
| **单步复杂度** | 数百行 OpenSCAD | 1 个几何操作 |
| **反馈粒度** | 编译/不编译 | 每步返回预览图 |
| **错误恢复** | 全量重写 | 局部重试 |
| **用户感知** | 黑箱 → 突然出结果 | 逐步构建，实时预览 |
| **模型开销** | 一次性高 token 消耗 | 多步但每步低 token |
| **服务端复杂度** | 简单的编译管道 | 需要场景图存储 + 代码生成器 |
| **实现工作量** | — | 场景图 + 代码生成器约 300-500 行 |

---

## 六、渐进式实施路径

如果一次性改造工作量太大，可以分步实施：

### Phase 1: 拆分 `finalize`

保持 `build_parametric_model` 不变，但新增 `declare_parameter` 工具。先让模型学会分步声明参数。

### Phase 2: 引入场景图

实现 `SceneGraph` 和 `toScad` 代码生成器。将 `create_primitive`、`apply_boolean`、`apply_transform` 作为新工具加入。`build_parametric_model` 降级为编译已有场景图。

### Phase 3: 淘汰单体工具

当原子工具的覆盖率足够高后，移除 `build_parametric_model`，强制模型使用逐步构建。

---

## 📌 更新日志

| 日期 | 更新内容 |
|------|----------|
| 2026-05-21 | 初版 — 分析当前单体 tool 局限性，设计原子化场景图架构 |

---

_更新时间：2026-05-21_
