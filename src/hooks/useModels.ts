import { useEffect, useState } from 'react';
import { CREATIVE_MODELS, PARAMETRIC_MODELS } from '@/lib/utils';
import type { ModelConfig } from '@/types/misc';

interface UseModelsResult {
  models: ModelConfig[];
  isLoading: boolean;
  error: string | null;
}

export function useModels(type: 'parametric' | 'creative'): UseModelsResult {
  const [models, setModels] = useState<ModelConfig[]>(
    type === 'creative' ? CREATIVE_MODELS : PARAMETRIC_MODELS,
  );
  const [isLoading, setIsLoading] = useState(type === 'parametric');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (type === 'creative') {
      setModels(CREATIVE_MODELS);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchModels = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await fetch(
          '/cadam/api/parametric-chat?action=getModels',
        );
        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.status}`);
        }
        const data = (await response.json()) as { models?: ModelConfig[] };
        if (
          !cancelled &&
          Array.isArray(data.models) &&
          data.models.length > 0
        ) {
          setModels(data.models);
        }
      } catch (err) {
        console.error('[useModels] Error fetching models:', err);
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load models',
          );
          setModels(PARAMETRIC_MODELS);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchModels();
    return () => {
      cancelled = true;
    };
  }, [type]);

  return { models, isLoading, error };
}
