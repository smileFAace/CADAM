import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model } from '@shared/types';
import type { ModelConfig } from '@/types/misc';
import { PARAMETRIC_MODELS } from '@/lib/utils';

export interface CustomModelConfig {
  apiModelId: string;
  name: string;
  description?: string;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  disabled?: boolean;
}

export interface ProviderCompatConfig {
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsToolChoice?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  requiresToolResultName?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiType?: 'openai' | 'anthropic' | 'google';
  compat?: ProviderCompatConfig;
  models: CustomModelConfig[];
}

interface ProvidersFile {
  builtinModels?: ModelConfig[];
  providers?: ProviderConfig[];
}

let cachedConfig: ProvidersFile | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

function loadConfig(): ProvidersFile {
  const now = Date.now();
  if (cachedConfig && now - cacheTimestamp < CACHE_TTL_MS) return cachedConfig;

  const configPath = resolve(process.cwd(), 'providers.local.json');
  if (!existsSync(configPath)) {
    cachedConfig = {};
    cacheTimestamp = now;
    return cachedConfig;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    cachedConfig = JSON.parse(raw) as ProvidersFile;
  } catch (error) {
    console.error('[models] Failed to read providers.local.json:', error);
    cachedConfig = {};
  }

  cacheTimestamp = now;
  return cachedConfig;
}

function toRuntimeModel(
  model: CustomModelConfig,
  providerName: string,
): ModelConfig {
  return {
    id: model.apiModelId,
    name: model.name,
    description: model.description || `Custom model from ${providerName}`,
    provider: providerName,
    supportsTools: model.supportsTools ?? true,
    supportsThinking: model.supportsThinking ?? false,
    supportsVision: model.supportsVision ?? false,
    disabled: model.disabled,
  };
}

export function getModels(): ModelConfig[] {
  const config = loadConfig();
  const builtinModels = config.builtinModels?.length
    ? config.builtinModels
    : PARAMETRIC_MODELS;

  const modelMap = new Map<Model, ModelConfig>();
  for (const model of builtinModels) modelMap.set(model.id, model);

  for (const provider of config.providers ?? []) {
    for (const model of provider.models) {
      modelMap.set(model.apiModelId, toRuntimeModel(model, provider.name));
    }
  }

  return Array.from(modelMap.values());
}

export function resolveCustomProvider(modelId: string): {
  baseUrl: string;
  apiKey: string;
  apiModelId: string;
  providerName: string;
  apiType: 'openai' | 'anthropic' | 'google';
  compat?: ProviderCompatConfig;
} | null {
  const config = loadConfig();

  for (const provider of config.providers ?? []) {
    const model = provider.models.find((entry) => entry.apiModelId === modelId);
    if (!model) continue;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiModelId: model.apiModelId,
      providerName: provider.name,
      apiType: provider.apiType ?? 'openai',
      compat: provider.compat,
    };
  }

  return null;
}
