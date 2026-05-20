/**
 * Test custom provider integration using the SAME code path as CADAM's aiChat.ts.
 *
 * Uses:
 *   - resolveCustomProvider() from models.ts
 *   - createOpenAI() + createOpenAICompatFetch() (same as aiChat.ts)
 *   - generateText() from ai with maxSteps (same flow as CADAM parametric)
 *
 * Usage:
 *   npx tsx scripts/test-custom-provider-via-sdk.ts [--model MODEL_ID]
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import {
  resolveCustomProvider,
  type ProviderCompatConfig,
} from '../src/server/models.js';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { z } from 'zod';

// ── Inline compat fetch (same logic as createOpenAICompatFetch in aiChat.ts) ──

function createOpenAICompatFetch(
  compat?: ProviderCompatConfig,
): FetchFunction | undefined {
  if (!compat) return undefined;

  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return fetch(input, init);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fetch(input, init);
    }

    if (
      compat.maxTokensField === 'max_tokens' &&
      'max_completion_tokens' in payload &&
      !('max_tokens' in payload)
    ) {
      payload.max_tokens = payload.max_completion_tokens;
      delete payload.max_completion_tokens;
    }

    if (
      compat.supportsDeveloperRole === false &&
      Array.isArray(payload.messages)
    ) {
      payload.messages = payload.messages.map((message) => {
        if (
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'developer'
        ) {
          return { ...message, role: 'system' };
        }
        return message;
      });
    }

    if (compat.requiresToolResultName && Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) => {
        if (
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'tool' &&
          !('name' in message)
        ) {
          return { ...message, name: 'tool' };
        }
        return message;
      });
    }

    if (compat.supportsUsageInStreaming === false)
      delete payload.stream_options;
    if (compat.supportsToolChoice === false) delete payload.tool_choice;

    if (
      compat.requiresReasoningContentOnAssistantMessages &&
      Array.isArray(payload.messages)
    ) {
      payload.messages = payload.messages.map((message) => {
        if (
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'assistant' &&
          !('reasoning_content' in message)
        ) {
          return { ...message, reasoning_content: '' };
        }
        return message;
      });
    }

    console.log(
      '[compat-fetch]',
      JSON.stringify({
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        keys: Object.keys(payload),
        messageRoles: Array.isArray(payload.messages)
          ? payload.messages.map((m) =>
              m && typeof m === 'object' && 'role' in m ? m.role : 'unknown',
            )
          : [],
      }),
    );

    return fetch(input, { ...init, body: JSON.stringify(payload) });
  };
}

// ── Parametric tool (same as CADAM) ──────────────────────────────────────

const buildParametricModelTool = tool({
  description: 'Create or modify an OpenSCAD parametric 3D model.',
  parameters: z.object({
    title: z.string().describe('Short object name'),
    version: z.string().describe('Version tag'),
    code: z.string().describe('Complete raw OpenSCAD code, no markdown fences'),
  }),
  execute: async (params) => {
    // Simulate the browser compiling the OpenSCAD code
    return {
      status: 'success',
      message: `Model "${params.title}" compiled successfully.`,
    };
  },
});

const SYSTEM_PROMPT = `You are Adam, an AI CAD editor that creates and modifies OpenSCAD models.
Use the build_parametric_model tool whenever the user asks for a CAD model.
Speak back briefly and let the tool carry the change.
Write correct, manifold, 3D-printable OpenSCAD code.
Declare every editable parameter as a top-of-file variable with Customizer comments.
Expose colors as string parameters named *_color.`;

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const requestedModel = (() => {
  const idx = args.indexOf('--model');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
})();

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const modelId = requestedModel ?? 'mimo-v2.5-pro';
  const custom = resolveCustomProvider(modelId);

  if (!custom) {
    console.error(
      `[test] Model "${modelId}" not found in providers.local.json`,
    );
    process.exit(1);
  }

  console.log('[test] Provider:', custom.providerName);
  console.log('[test] Model:', custom.apiModelId);
  console.log('[test] Compat:', JSON.stringify(custom.compat ?? {}));
  console.log();

  // SAME as aiChat.ts buildChatModel() for custom-openai
  const openai = createOpenAI({
    baseURL: custom.baseUrl,
    apiKey: custom.apiKey,
    fetch: createOpenAICompatFetch(custom.compat),
  });
  const model = openai.chat(custom.apiModelId);

  // ── Turn 1 ───────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('[Turn 1] 创建一个正方体');
  console.log('='.repeat(60));

  const turn1 = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: '创建一个正方体' }],
    tools: { build_parametric_model: buildParametricModelTool },
    maxSteps: 2, // allow tool call → tool result → continue
  });

  console.log(`finishReason: ${turn1.finishReason}`);
  console.log(`steps: ${turn1.steps.length}`);
  console.log(`text: ${turn1.text}`);
  console.log(`toolCalls: ${turn1.toolCalls.length}`);
  for (const tc of turn1.toolCalls) {
    const input = (tc.input ?? {}) as { title?: string; code?: string };
    console.log(`[tool-call] ${tc.toolName}: title="${input.title ?? ''}"`);
    const code = input.code ?? '';
    console.log(
      `  code (${code.split('\n').length} lines):\n${code.split('\n').slice(0, 8).join('\n')}...`,
    );
  }
  for (const tr of turn1.toolResults) {
    console.log(`[tool-result]`, JSON.stringify(tr, null, 2).slice(0, 200));
  }

  // ── Turn 2: replay messages and continue ─────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('[Turn 2] 上面加一个圆柱体');
  console.log('='.repeat(60));

  // CADAM rebuilds messages from DB. Here we use turn1.response.messages
  // which is the AI SDK's canonical representation of the conversation so far.
  const turn1ResponseMessages = turn1.response.messages;

  console.log(`turn1 response.messages: ${turn1ResponseMessages.length}`);
  for (const m of turn1ResponseMessages) {
    const role = 'role' in m ? m.role : 'unknown';
    const summary =
      'content' in m
        ? `[${typeof m.content === 'string' ? 'text' : Array.isArray(m.content) ? `${m.content.length} parts` : 'other'}]`
        : '';
    console.log(`  ${role} ${summary}`);
  }

  const turn2 = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user' as const, content: '创建一个正方体' },
      ...turn1ResponseMessages,
      { role: 'user' as const, content: '上面加一个圆柱体' },
    ],
    tools: { build_parametric_model: buildParametricModelTool },
    maxSteps: 2,
  });

  console.log(`finishReason: ${turn2.finishReason}`);
  console.log(`steps: ${turn2.steps.length}`);
  console.log(`text: ${turn2.text}`);
  console.log(`toolCalls: ${turn2.toolCalls.length}`);
  for (const tc of turn2.toolCalls) {
    const input = (tc.input ?? {}) as { title?: string; code?: string };
    console.log(`[tool-call] ${tc.toolName}: title="${input.title ?? ''}"`);
    const code = input.code ?? '';
    console.log(
      `  code (${code.split('\n').length} lines):\n${code.split('\n').slice(0, 8).join('\n')}...`,
    );
  }
  for (const tr of turn2.toolResults) {
    console.log(`[tool-result]`, JSON.stringify(tr, null, 2).slice(0, 200));
  }

  console.log('\n' + '='.repeat(60));
  console.log('[test] ✅ Both turns completed via AI SDK!');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('[test] Fatal error:', err);
  process.exit(1);
});
