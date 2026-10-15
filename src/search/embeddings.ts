import type { Logger } from '../util/logger.js';

/**
 * Extension point for optional local embeddings (planned for a later version).
 * v0.1 ships NO embedding provider and makes NO semantic-search claims.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderFactory = () => EmbeddingProvider;

const registry = new Map<string, EmbeddingProviderFactory>();

export function registerEmbeddingProvider(name: string, factory: EmbeddingProviderFactory): void {
  registry.set(name, factory);
}

export interface EmbeddingResolution {
  provider: EmbeddingProvider | null;
  warning: string | null;
}

/** Resolve a configured provider; missing or failing providers degrade to keyword retrieval. */
export function resolveEmbeddingProvider(name: string | null, logger: Logger): EmbeddingResolution {
  if (!name) return { provider: null, warning: null };
  const factory = registry.get(name);
  if (!factory) {
    const warning = `Embedding provider "${name}" is not available in this build; using keyword retrieval only.`;
    logger.warn(warning);
    return { provider: null, warning };
  }
  try {
    return { provider: factory(), warning: null };
  } catch (err) {
    const warning = `Embedding provider "${name}" failed to initialise (${(err as Error).message}); using keyword retrieval only.`;
    logger.warn(warning);
    return { provider: null, warning };
  }
}
