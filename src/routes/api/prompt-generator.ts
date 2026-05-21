import { createFileRoute } from '@tanstack/react-router';
import { generateText } from 'ai';
import { buildChatModel, createChatProviders } from '@/server/aiChat';
import {
  isRecord,
  isUnauthorizedError,
  json,
  methodNotAllowed,
  preflight,
  requireUser,
} from '@/server/api';
import type { Model } from '@shared/types';

const CREATIVE_PROMPT =
  'Generate a short creative prompt for an organic 3D form, character, figurine, sculpture, or artistic object. Return only the prompt text.';
const PARAMETRIC_PROMPT =
  'Generate a short prompt for a practical dimensional household object or functional part. Include dimensions when useful. Return only the prompt text.';
const MAX_EXISTING_TEXT_LENGTH = 2000;

export const Route = createFileRoute('/api/prompt-generator')({
  server: {
    handlers: {
      GET: methodNotAllowed,
      OPTIONS: preflight,
      POST: async ({ request }) => {
        try {
          await requireUser(request);
          const body = await request.json().catch(() => ({}));
          if (!isRecord(body)) {
            return json({ error: 'invalid_request' }, 400);
          }
          if (
            body.existingText !== undefined &&
            (typeof body.existingText !== 'string' ||
              body.existingText.length > MAX_EXISTING_TEXT_LENGTH)
          ) {
            return json({ error: 'invalid_existing_text' }, 400);
          }
          const existingText = body.existingText as string | undefined;
          const base =
            body.type === 'parametric' ? PARAMETRIC_PROMPT : CREATIVE_PROMPT;
          const content = existingText
            ? `${base}\n\nImprove this existing prompt while preserving its intent:\n${existingText}`
            : base;

          // Use the user's selected model (or fallback to claude-haiku-4-5)
          const modelId =
            typeof body.model === 'string'
              ? (body.model as Model)
              : ('anthropic/claude-haiku-4-5' as Model);

          let providers = createChatProviders();
          const { model } = buildChatModel(modelId, providers, false);

          const result = await generateText({
            model,
            system:
              'You write concise 3D generation prompts. Return only the prompt text, no quotes or explanation.',
            prompt: content,
          });

          return json({ prompt: result.text.trim() });
        } catch (err) {
          return json(
            {
              error: isUnauthorizedError(err)
                ? 'Unauthorized'
                : 'prompt_failed',
            },
            isUnauthorizedError(err) ? 401 : 500,
          );
        }
      },
    },
  },
});
