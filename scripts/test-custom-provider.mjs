#!/usr/bin/env node

/**
 * Local test script for CADAM custom provider integration.
 *
 * Simulates a two-turn parametric conversation:
 *   1. "创建一个正方体"
 *   2. "上面加一个圆柱体"
 *
 * Usage:
 *   node scripts/test-custom-provider.mjs [--baseUrl URL] [--apiKey KEY] [--model MODEL]
 *
 * Defaults read from providers.local.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

// ── Load config from providers.local.json ─────────────────────────────────
const configPath = resolve(process.cwd(), 'providers.local.json');
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
  console.error('[test] Cannot read providers.local.json');
}

const provider = config.providers?.[0] ?? {};
const baseUrl = getArg('baseUrl', provider.baseUrl ?? 'http://localhost:3000');
const apiKey = getArg('apiKey', provider.apiKey ?? '');
const apiModelId = getArg('model', provider.models?.[0]?.apiModelId ?? 'mimo-v2.5-pro');
const apiType = getArg('apiType', provider.apiType ?? 'openai');

console.log('[test] Config:');
console.log(`  baseUrl:   ${baseUrl}`);
console.log(`  model:     ${apiModelId}`);
console.log(`  apiType:   ${apiType}`);
console.log(`  apiKey:    ${apiKey ? apiKey.slice(0, 8) + '...' : '(none)'}`);
console.log();

// ── Build request body ────────────────────────────────────────────────────
function buildBody(messages, tools) {
  const body = {
    model: apiModelId,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  return body;
}

// ── Minimal OpenSCAD tool for parametric mode ─────────────────────────────
const PARAMETRIC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'build_parametric_model',
      description:
        'Create or modify an OpenSCAD parametric 3D model. Return the complete code and parameters.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short object name' },
          version: { type: 'string', description: 'Version tag, e.g. "v1"' },
          code: {
            type: 'string',
            description: 'Complete raw OpenSCAD code, no markdown fences',
          },
        },
        required: ['title', 'version', 'code'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Adam, an AI CAD editor that creates and modifies OpenSCAD models.
Use the build_parametric_model tool whenever the user asks for a CAD model.
Speak back briefly and let the tool carry the change.
Write correct, manifold, 3D-printable OpenSCAD code.
Declare every editable parameter as a top-of-file variable with Customizer comments.
Expose colors as string parameters named *_color.`;

// ── Send one request and collect the response ─────────────────────────────
async function sendRequest(messages, turnLabel) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[turn] ${turnLabel}`);
  console.log(`${'='.repeat(60)}`);

  const body = buildBody(messages, PARAMETRIC_TOOLS);

  // Print a summary of what we're sending
  console.log(`[request] POST ${baseUrl}/v1/chat/completions`);
  console.log(`[request] model: ${body.model}`);
  console.log(`[request] tools: ${body.tools ? body.tools.length : 0}`);
  console.log(`[request] messages: ${body.messages.length}`);
  for (const m of body.messages) {
    const preview =
      typeof m.content === 'string'
        ? m.content.slice(0, 80).replace(/\n/g, '\\n')
        : JSON.stringify(m.content).slice(0, 80);
    console.log(`  ${m.role}: ${preview}${preview.length >= 80 ? '...' : ''}`);
  }

  const url = `${baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Anthropic-compatible providers may use x-api-key instead
    'x-api-key': apiKey,
  };

  const startTime = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - startTime;
    console.log(`\n[response] status: ${res.status} (${elapsed}ms)`);

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[response] ERROR body:\n${errText}`);
      return null;
    }

    // Read SSE stream
    let assistantContent = '';
    let toolCalls = [];
    let finishReason = null;
    let currentToolCall = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          const reason = chunk.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;

          if (delta?.content) {
            assistantContent += delta.content;
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: '', name: '', arguments: '' };
                }
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
              }
            }
          }
        } catch {
          // ignore parse errors on partial SSE chunks
        }
      }
    }

    console.log(`\n[assistant] finish_reason: ${finishReason}`);

    if (assistantContent) {
      console.log(`[assistant] text:\n${assistantContent}`);
    }

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        console.log(`\n[tool_call] ${tc.name} (${tc.id})`);
        try {
          const parsed = JSON.parse(tc.arguments);
          console.log(`  title: ${parsed.title}`);
          console.log(`  version: ${parsed.version}`);
          const codePreview = (parsed.code ?? '').split('\n').slice(0, 10).join('\n');
          console.log(`  code (first 10 lines):\n${codePreview}`);
          if ((parsed.code ?? '').split('\n').length > 10) {
            console.log(`  ... (${parsed.code.split('\n').length} lines total)`);
          }
        } catch {
          console.log(`  raw args: ${tc.arguments.slice(0, 200)}`);
        }
      }
    }

    return {
      content: assistantContent,
      toolCalls,
      finishReason,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[error] after ${elapsed}ms: ${err.message}`);
    return null;
  }
}

// ── Main conversation flow ────────────────────────────────────────────────
async function main() {
  console.log('[test] Starting CADAM custom provider test...\n');

  // ── Turn 1: "创建一个正方体" ──────────────────────────────────────────
  const turn1Messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '创建一个正方体' },
  ];

  const turn1 = await sendRequest(turn1Messages, 'Turn 1: 创建一个正方体');

  if (!turn1) {
    console.error('\n[test] Turn 1 failed. Aborting.');
    process.exit(1);
  }

  // ── Turn 2: "上面加一个圆柱体" ────────────────────────────────────────
  // Build conversation history for turn 2
  const turn2Messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '创建一个正方体' },
  ];

  // Add assistant response from turn 1
  if (turn1.toolCalls.length > 0) {
    // Assistant made tool calls
    // NOTE: MiMo requires reasoning_content on assistant messages when replaying
    const assistantMsg = { role: 'assistant', content: turn1.content || null, reasoning_content: '', tool_calls: [] };
    for (const tc of turn1.toolCalls) {
      assistantMsg.tool_calls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      });
    }
    turn2Messages.push(assistantMsg);

    // Add tool results
    for (const tc of turn1.toolCalls) {
      turn2Messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ status: 'success', message: 'Model compiled successfully.' }),
      });
    }
  } else {
    // Assistant replied with text only
    turn2Messages.push({ role: 'assistant', content: turn1.content });
  }

  turn2Messages.push({ role: 'user', content: '上面加一个圆柱体' });

  const turn2 = await sendRequest(turn2Messages, 'Turn 2: 上面加一个圆柱体');

  if (!turn2) {
    console.error('\n[test] Turn 2 failed.');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('[test] ✅ All turns completed successfully!');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('[test] Fatal error:', err);
  process.exit(1);
});
