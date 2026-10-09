import { v } from 'convex/values';
import { ActionCtx, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { Id } from '../_generated/dataModel';
import { fetchEmbeddingBatch } from '../util/llm';
import { activeRoute, EmbeddingRoute, profileEmbeddingConfig } from '../models/embeddings';
import { assertTownUnlocked } from '../federation/maintenanceLock';
import { cacheWritesAllowed } from '../federation/storagePolicy';
import { validateVector } from '../models/compatibility';

export function cacheNamespace(route: EmbeddingRoute, inputMode: 'query' | 'document') {
  return JSON.stringify([
    route.space._id,
    route.profile.fingerprint,
    route.profile.preprocessingRevision,
    inputMode,
  ]);
}
export type CacheOptions = { route?: EmbeddingRoute; inputMode?: 'query' | 'document' };

const selfInternal = internal.agent.embeddingsCache;

export async function fetch(ctx: ActionCtx, text: string, options: CacheOptions = {}) {
  const result = await fetchBatch(ctx, [text], options);
  return result.embeddings[0];
}

export async function fetchBatch(
  ctx: ActionCtx,
  texts: string[],
  options: CacheOptions = {},
): Promise<{ embeddings: number[][]; hits: number; ms: number }> {
  const route = options.route ?? (await activeRoute(ctx));
  const inputMode = options.inputMode ?? 'query';
  const namespace = cacheNamespace(route, inputMode);
  const start = Date.now();

  const textHashes = await Promise.all(texts.map((text) => hashText(text)));
  const results = new Array<number[]>(texts.length);
  const cacheResults = await ctx.runQuery(selfInternal.getEmbeddingsByText, {
    textHashes,
    namespace,
  });
  for (const { index, embedding } of cacheResults) {
    validateVector(embedding, route.profile.dimensions);
    results[index] = embedding;
  }
  const toWrite = [];
  if (cacheResults.length < texts.length) {
    const missingIndexes = [...results.keys()].filter((i) => !results[i]);
    const missingTexts = missingIndexes.map((i) => texts[i]);
    const response = await fetchEmbeddingBatch(
      missingTexts,
      profileEmbeddingConfig(route.profile),
      inputMode,
    );
    if (response.embeddings.length !== missingIndexes.length) {
      throw new Error(
        `Expected ${missingIndexes.length} embeddings, got ${response.embeddings.length}`,
      );
    }
    for (let i = 0; i < missingIndexes.length; i++) {
      const resultIndex = missingIndexes[i];
      validateVector(response.embeddings[i], route.profile.dimensions);
      toWrite.push({
        textHash: textHashes[resultIndex],
        embedding: response.embeddings[i],
      });
      results[resultIndex] = response.embeddings[i];
    }
  }
  if (toWrite.length > 0) {
    await ctx.runMutation(selfInternal.writeEmbeddings, { embeddings: toWrite, namespace });
  }
  return {
    embeddings: results,
    hits: cacheResults.length,
    ms: Date.now() - start,
  };
}

async function hashText(text: string) {
  const textEncoder = new TextEncoder();
  const buf = textEncoder.encode(text);
  if (typeof crypto === 'undefined') {
    // Ugly, ugly hax to get ESBuild to not try to bundle this node dependency.
    const f = () => 'node:crypto';
    const crypto = (await import(f())) as typeof import('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(buf);
    const bytes = hash.digest();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } else {
    return await crypto.subtle.digest('SHA-256', buf);
  }
}

export const getEmbeddingsByText = internalQuery({
  args: { textHashes: v.array(v.bytes()), namespace: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ index: number; embeddingId: Id<'embeddingsCache'>; embedding: number[] }[]> => {
    const out = [];
    for (let i = 0; i < args.textHashes.length; i++) {
      const textHash = args.textHashes[i];
      const result = await ctx.db
        .query('embeddingsCache')
        .withIndex('namespace_text', (q) =>
          q.eq('namespace', args.namespace).eq('textHash', textHash),
        )
        .first();
      if (result) {
        out.push({
          index: i,
          embeddingId: result._id,
          embedding: result.embedding,
        });
      }
    }
    return out;
  },
});

export const writeEmbeddings = internalMutation({
  args: {
    namespace: v.string(),
    embeddings: v.array(
      v.object({
        textHash: v.bytes(),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Id<'embeddingsCache'>[]> => {
    await assertTownUnlocked(ctx);
    if (!(await cacheWritesAllowed(ctx))) return [];
    const ids = [];
    for (const embedding of args.embeddings) {
      const prior = await ctx.db
        .query('embeddingsCache')
        .withIndex('namespace_text', (q) =>
          q.eq('namespace', args.namespace).eq('textHash', embedding.textHash),
        )
        .first();
      ids.push(
        prior?._id ??
          (await ctx.db.insert('embeddingsCache', { ...embedding, namespace: args.namespace })),
      );
    }
    return ids;
  },
});
