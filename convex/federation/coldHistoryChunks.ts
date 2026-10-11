import { v } from 'convex/values';
import { action, mutation, query, internalMutation, internalQuery } from '../_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { archiveFor, source, type Payload } from './coldHistory';
import { ownerArgs, type OwnerArgs } from './coldHistoryOwner';
import { assertTownUnlocked } from './maintenanceLock';
import { identity } from './store';
import { digest, requireAdmin, sign, verifySignature } from './security';
import { queryRef, mutationRef } from './refs';
import {
  COLD_CHUNK_MAX_BYTES, COLD_CHUNK_TARGET_BYTES, COLD_CHUNK_MAX_MESSAGES,
  EMPTY_COLD_CHAIN, chunkCertificate, coldBytes, describeColdChunk,
  validateChunkRoot, validateColdMessages, validateColdPart,
  coldExactKeys, type ChunkManifest, type ChunkPayload, type ColdChunkDescriptor, type PortableColdPart, type PortableColdRoot,
} from './coldHistoryChunkFormat';

type Job = Doc<'coldHistoryJobs'>;
const jobArgs = { ...ownerArgs, jobId: v.id('coldHistoryJobs') };
const terminal = new Set(['COMPLETE', 'CANCELLED']);
function view(j: Job) {
  return { jobId: j._id, archiveId: j.archiveId, state: j.state, phase: j.phase,
    revision: j.revision, count: j.count, bytes: j.bytes, chunkCount: j.chunkCount,
    verifiedChunks: j.verifiedChunks, error: j.error, hotRecordsRetained: true as const };
}
async function owned(ctx: QueryCtx | MutationCtx, args: OwnerArgs & { jobId: Id<'coldHistoryJobs'> }) {
  const s = await source(ctx, args), job = await ctx.db.get(args.jobId);
  if (!job || job.source.sourceKey !== s.sourceKey || job.owner.worldId !== args.worldId ||
      job.owner.playerId !== args.playerId || job.owner.agentGlobalId !== args.agentGlobalId || job.owner.memoryId !== args.memoryId)
    throw new Error('COLD_HISTORY_JOB_OWNER_MISMATCH');
  if (!terminal.has(job.state)) {
    const lock = await ctx.db.query('coldHistoryLocks').withIndex('key', q => q.eq('key', 'town')).unique();
    if (lock?.jobId !== job._id) throw new Error('COLD_HISTORY_MAINTENANCE_LOCK_LOST');
  }
  if (await digest(s) !== await digest(job.source)) throw new Error('COLD_HISTORY_SOURCE_CHANGED');
  return job;
}
async function stable(ctx: QueryCtx | MutationCtx) {
  const local = await identity(ctx);
  if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
  if (local.enabled) throw new Error('DISABLE_FEDERATION_BEFORE_COLD_HISTORY');
  if (await ctx.db.query('engines').filter(q => q.eq(q.field('running'), true)).first())
    throw new Error('STOP_TARGET_ENGINE_FIRST');
  if (await ctx.db.query('visitLedger').filter(q => q.and(
    q.neq(q.field('state'), 'COMPLETED'), q.neq(q.field('state'), 'REJECTED'))).first())
    throw new Error('RECONCILE_ACTIVE_VISITS_BEFORE_COLD_HISTORY');
  return local;
}
export const start = mutation({
  args: ownerArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const s = await source(ctx, args), existing = await archiveFor(ctx, s.sourceKey);
    if (existing?.state === 'VERIFIED') return { archiveId: existing._id, state: 'VERIFIED' as const, count: existing.manifest.count };
    if (existing?.jobId) return view(await owned(ctx, { ...args, jobId: existing.jobId }));
    await assertTownUnlocked(ctx);
    const local = await stable(ctx), now = Date.now(), snapshotId = crypto.randomUUID();
    const manifest = { format: 'ai-town-cold-history', version: 2, schemaVersion: 1,
      sourceTownId: local.townId, sourceKey: s.sourceKey, kind: s.kind, sourceId: s.sourceId,
      snapshotId, exportedAt: now, chunkCount: 0, count: 0, bytes: 0, digest: EMPTY_COLD_CHAIN };
    const fields = { sourceKey: s.sourceKey, lookupKey: s.sourceKey, sourceId: s.sourceId,
      kind: s.kind, worldId: args.worldId, ownerGlobalId: s.ownerGlobalId, state: 'PENDING' as const,
      manifest, signature: '', publicKey: local.publicKey, createdAt: existing?.createdAt ?? now };
    const archiveId = existing?._id ?? await ctx.db.insert('coldHistoryArchives', fields);
    if (existing) await ctx.db.replace(archiveId, fields);
    const { adminToken: _adminToken, ...owner } = args;
    const jobId = await ctx.db.insert('coldHistoryJobs', { archiveId, owner, source: s, snapshotId, kind: 'archive',
      state: 'RUNNING', phase: 'CAPTURE', revision: 0, cursor: null, pageNumber: 0,
      messageOffset: 0, chunkCount: 0, count: 0, bytes: 0, chainDigest: EMPTY_COLD_CHAIN,
      verifiedChunks: 0, createdAt: now, updatedAt: now });
    await ctx.db.patch(archiveId, { jobId });
    await ctx.db.insert('coldHistoryLocks', { key: 'town', jobId, createdAt: now });
    return view((await ctx.db.get(jobId))!);
  },
});
export const status = query({ args: jobArgs, handler: async (ctx, args) => view(await owned(ctx, args)) });
export const jobData = internalQuery({ args: jobArgs, handler: owned });
async function capturePage(ctx: QueryCtx | MutationCtx, job: Job): Promise<{
  messages: Payload['messages']; cursor: string; done: boolean; pageNumber: number;
}> {
  const args = job.owner as OwnerArgs, s = job.source;
  if (s.kind === 'conversation') {
    const page = await ctx.db.query('messages').withIndex('conversationId', q =>
      q.eq('worldId', args.worldId).eq('conversationId', s.sourceId)).order('asc')
      .paginate({ cursor: job.cursor, numItems: 25, maximumBytesRead: COLD_CHUNK_MAX_BYTES });
    return { messages: page.page.map(r => ({ messageId: r.messageUuid, text: r.text,
      authorPlayerId: r.author, occurredAt: r._creationTime })), cursor: page.continueCursor,
      done: page.isDone, pageNumber: job.pageNumber + 1 };
  }
  const page = await ctx.db.query('homeTravelTranscriptPages').withIndex('owner_transcript_page', q =>
    q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', s.sourceId))
    .paginate({ cursor: job.cursor, numItems: 1, maximumBytesRead: COLD_CHUNK_MAX_BYTES });
  if (!page.page.length || page.page[0].pageNumber !== job.pageNumber || page.page[0].finalPage !== page.isDone ||
      !Number.isSafeInteger(s.expectedPageCount) || s.expectedPageCount < 1 ||
      page.page[0].pageNumber >= s.expectedPageCount || page.isDone !== (job.pageNumber + 1 === s.expectedPageCount))
    throw new Error('COLD_HISTORY_INCOMPLETE_PAGES');
  return { messages: page.page.flatMap(r => r.messages.map(m => ({ messageId: m.messageId,
    text: m.text, authorGlobalId: m.author, occurredAt: m.occurredAt }))),
    cursor: page.continueCursor, done: page.isDone, pageNumber: job.pageNumber + 1 };
}
export const pageData = internalQuery({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); await stable(ctx);
    if (job.state !== 'RUNNING' || !['CAPTURE', 'VERIFY_TARGET'].includes(job.phase)) throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    return capturePage(ctx, job);
  },
});
function descriptor(row: Doc<'coldHistoryChunks'>): ColdChunkDescriptor {
  const { index, start, count, bytes, digest, previousDigest, chainDigest } = row;
  return { index, start, count, bytes, digest, previousDigest, chainDigest };
}
export const savePage = internalMutation({
  args: { ...jobArgs, revision: v.number(), pageDigest: v.string(), chunks: v.array(v.object({ payload: v.any(), descriptor: v.any(), storageId: v.id('_storage') })) },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); const local = await stable(ctx);
    if (job.revision !== args.revision || job.phase !== 'CAPTURE' || job.state !== 'RUNNING') throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const page = await capturePage(ctx, job);
    if (await digest(page) !== args.pageDigest) throw new Error('COLD_HISTORY_SOURCE_CHANGED');
    const originals = args.chunks.flatMap(c => (c.payload as ChunkPayload).messages);
    if (await digest(originals) !== await digest(page.messages)) throw new Error('COLD_HISTORY_SOURCE_CHANGED');
    let count = job.count, bytes = job.bytes, chain = job.chainDigest, chunkCount = job.chunkCount;
    for (const chunk of args.chunks) {
      const p = chunk.payload as ChunkPayload, d = await describeColdChunk(p, chain);
      if (p.sourceKey !== job.source.sourceKey || p.snapshotId !== job.snapshotId || p.index !== chunkCount || p.start !== count ||
          coldBytes(p) > COLD_CHUNK_MAX_BYTES || p.messages.length > COLD_CHUNK_MAX_MESSAGES || await digest(d) !== await digest(chunk.descriptor))
        throw new Error('COLD_HISTORY_CHUNK_INVALID');
      validateColdMessages(p.messages, job.source.kind);
      for (const m of p.messages) {
        if (await ctx.db.query('coldHistoryMessageIds').withIndex('job_message', q => q.eq('jobId', job._id).eq('messageId', m.messageId)).unique())
          throw new Error('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
        await ctx.db.insert('coldHistoryMessageIds', { jobId: job._id, messageId: m.messageId });
      }
      await ctx.db.insert('coldHistoryChunks', { archiveId: job.archiveId, jobId: job._id, ...d,
        storageId: chunk.storageId, cumulativeBytes: bytes + d.bytes,
        signature: await sign(chunkCertificate(p.sourceKey, p.snapshotId, d), local.privateKeyEncrypted) });
      count += d.count; bytes += d.bytes; chain = d.chainDigest; chunkCount++;
    }
    if (page.done && (!count || (job.source.kind === 'travel' ? count !== job.source.expectedCount : count < job.source.expectedCount)))
      throw new Error('COLD_HISTORY_INCOMPLETE_MESSAGES');
    await ctx.db.patch(job._id, { cursor: page.done ? null : page.cursor, pageNumber: page.pageNumber,
      phase: page.done ? 'VERIFY' : 'CAPTURE', count, bytes, chainDigest: chain, chunkCount,
      revision: job.revision + 1, updatedAt: Date.now() });
  },
});
export const verifyData = internalQuery({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); await stable(ctx);
    if (job.phase !== 'VERIFY' || job.state !== 'RUNNING') throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const chunk = await ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', job.archiveId).eq('index', job.verifiedChunks)).unique();
    if (!chunk) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    return { chunk, archive: (await ctx.db.get(job.archiveId))! };
  },
});
export const saveVerified = internalMutation({
  args: { ...jobArgs, revision: v.number(), index: v.number(), contentDigest: v.string() },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); await stable(ctx);
    if (job.revision !== args.revision || job.phase !== 'VERIFY' || job.state !== 'RUNNING' || job.verifiedChunks !== args.index)
      throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const chunk = await ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', job.archiveId).eq('index', args.index)).unique();
    if (!chunk || chunk.digest !== args.contentDigest) throw new Error('COLD_HISTORY_INTEGRITY_FAILED');
    await ctx.db.patch(chunk._id, { jobId: undefined });
    await ctx.db.patch(job._id, { verifiedChunks: job.verifiedChunks + 1,
      phase: job.verifiedChunks + 1 === job.chunkCount ? 'PUBLISH' : 'VERIFY', revision: job.revision + 1, updatedAt: Date.now() });
  },
});
async function release(ctx: MutationCtx, job: Job, state: 'COMPLETE' | 'CANCELLED') {
  const lock = await ctx.db.query('coldHistoryLocks').withIndex('key', q => q.eq('key', 'town')).unique();
  if (lock?.jobId !== job._id) throw new Error('COLD_HISTORY_MAINTENANCE_LOCK_LOST');
  await ctx.db.delete(lock._id);
  await ctx.db.patch(job._id, { state, revision: job.revision + 1, updatedAt: Date.now(), error: undefined });
}
export const publish = internalMutation({
  args: { ...jobArgs, revision: v.number() },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args), local = await stable(ctx);
    if (job.revision !== args.revision || job.phase !== 'PUBLISH' || job.state !== 'RUNNING' || job.verifiedChunks !== job.chunkCount)
      throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const archive = (await ctx.db.get(job.archiveId))!;
    const manifest: ChunkManifest = { ...archive.manifest, chunkCount: job.chunkCount, count: job.count, bytes: job.bytes, digest: job.chainDigest };
    if (job.kind === 'import' && await digest(manifest) !== await digest(job.fileRoot.manifest))
      throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    await ctx.db.patch(archive._id, { state: 'VERIFIED', manifest, jobId: undefined,
      signature: job.kind === 'import' ? job.fileRoot.signature : await sign(manifest, local.privateKeyEncrypted), verifiedAt: Date.now() });
    await release(ctx, job, 'COMPLETE');
  },
});
const aliasesValidator = v.array(v.object({ sourceAuthor: v.string(), targetAuthor: v.string() }));
export const startImport = mutation({
  args: { ...ownerArgs, rootJson: v.string(), expectedFingerprint: v.string(), authorAliases: aliasesValidator },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (new TextEncoder().encode(args.rootJson).length > 20_000) throw new Error('COLD_FILE_SIZE_LIMIT');
    const root: PortableColdRoot = JSON.parse(args.rootJson);
    if (!coldExactKeys(root, ['format', 'version', 'manifest', 'publicKey', 'signature']) || root.format !== 'ai-town-cold-history-manifest' || root.version !== 2)
      throw new Error('UNSUPPORTED_COLD_FILE');
    await validateChunkRoot(root.manifest, root.signature, root.publicKey);
    if (args.expectedFingerprint !== `sha256:${await digest(root.publicKey)}`) throw new Error('COLD_FILE_INDEPENDENT_FINGERPRINT_REQUIRED');
    const s = await source(ctx, args), existing = await archiveFor(ctx, s.sourceKey);
    if (s.kind !== root.manifest.kind) throw new Error('COLD_FILE_TARGET_KIND_MISMATCH');
    if (args.authorAliases.length > 100 || new Set(args.authorAliases.map(a => a.sourceAuthor)).size !== args.authorAliases.length ||
        new Set(args.authorAliases.map(a => a.targetAuthor)).size !== args.authorAliases.length ||
        args.authorAliases.some(a => !a.sourceAuthor || !a.targetAuthor)) throw new Error('COLD_FILE_AUTHOR_MAPPING_INVALID');
    const authorAliases = [...args.authorAliases].sort((a, b) => a.sourceAuthor.localeCompare(b.sourceAuthor));
    if (s.kind === 'travel') {
      const originalOwner = JSON.parse(root.manifest.sourceKey)[2];
      if ((authorAliases.find(a => a.sourceAuthor === originalOwner)?.targetAuthor ?? originalOwner) !== args.agentGlobalId)
        throw new Error('COLD_FILE_OWNER_MAPPING_REQUIRED');
    }
    if (existing?.state === 'VERIFIED') {
      if (await digest(existing.manifest) !== await digest(root.manifest) || existing.publicKey !== root.publicKey ||
          existing.signature !== root.signature || await digest(existing.authorAliases ?? []) !== await digest(authorAliases))
        throw new Error('COLD_FILE_TARGET_ALREADY_ARCHIVED');
      return { archiveId: existing._id, state: 'VERIFIED' as const, count: existing.manifest.count };
    }
    if (existing?.jobId) {
      const job = await owned(ctx, { ...args, jobId: existing.jobId });
      if (job.kind !== 'import' || await digest(job.fileRoot) !== await digest(root) || await digest(job.authorAliases) !== await digest(authorAliases))
        throw new Error('COLD_HISTORY_JOB_IN_PROGRESS');
      return view(job);
    }
    await assertTownUnlocked(ctx); await stable(ctx);
    const now = Date.now(), fields = { sourceKey: root.manifest.sourceKey, lookupKey: s.sourceKey, sourceId: root.manifest.sourceId,
      kind: s.kind, worldId: args.worldId, ownerGlobalId: s.ownerGlobalId, state: 'PENDING' as const,
      manifest: root.manifest, signature: root.signature, publicKey: root.publicKey, authorAliases,
      importedAt: now, createdAt: existing?.createdAt ?? now };
    const archiveId = existing?._id ?? await ctx.db.insert('coldHistoryArchives', fields);
    if (existing) await ctx.db.replace(archiveId, fields);
    const { adminToken: _adminToken, rootJson: _rootJson, expectedFingerprint: _fingerprint, authorAliases: _aliases, ...owner } = args;
    const jobId = await ctx.db.insert('coldHistoryJobs', { archiveId, owner, source: s, kind: 'import', fileRoot: root,
      expectedFingerprint: args.expectedFingerprint, authorAliases, seenAliases: [], snapshotId: root.manifest.snapshotId,
      state: 'RUNNING', phase: 'IMPORT_STAGE', revision: 0, cursor: null, pageNumber: 0, messageOffset: 0,
      chunkCount: 0, count: 0, bytes: 0, chainDigest: EMPTY_COLD_CHAIN, verifiedChunks: 0, createdAt: now, updatedAt: now });
    await ctx.db.patch(archiveId, { jobId });
    await ctx.db.insert('coldHistoryLocks', { key: 'town', jobId, createdAt: now });
    return view((await ctx.db.get(jobId))!);
  },
});
export const saveImportPart = internalMutation({
  args: { ...jobArgs, revision: v.number(), fileJson: v.string(), storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); await stable(ctx);
    if (job.kind !== 'import' || job.phase !== 'IMPORT_STAGE' || job.state !== 'RUNNING' || job.revision !== args.revision)
      throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const part = await validateColdPart(JSON.parse(args.fileJson), job.expectedFingerprint!), d = part.descriptor;
    if (await digest({ format: 'ai-town-cold-history-manifest', version: 2, manifest: part.manifest, publicKey: part.publicKey, signature: part.signature }) !== await digest(job.fileRoot) ||
        d.index !== job.chunkCount || d.start !== job.count || d.previousDigest !== job.chainDigest)
      throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    const mapping = new Map((job.authorAliases ?? []).map(a => [a.sourceAuthor, a.targetAuthor]));
    const authors = new Set<string>();
    for (const m of part.payload.messages) {
      if (await ctx.db.query('coldHistoryMessageIds').withIndex('job_message', q => q.eq('jobId', job._id).eq('messageId', m.messageId)).unique())
        throw new Error('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
      const author = m.authorGlobalId ?? m.authorPlayerId!; authors.add(author);
      await ctx.db.insert('coldHistoryMessageIds', { jobId: job._id, messageId: m.messageId,
        expectedHash: await digest({ messageId: m.messageId, text: m.text, author: mapping.get(author) ?? author }) });
    }
    if (part.manifest.kind === 'travel') authors.add(JSON.parse(part.manifest.sourceKey)[2]);
    const seenAliases = [...new Set([...(job.seenAliases ?? []), ...(job.authorAliases ?? []).filter(a => authors.has(a.sourceAuthor)).map(a => a.sourceAuthor)])];
    const count = job.count + d.count, bytes = job.bytes + d.bytes, done = d.index + 1 === part.manifest.chunkCount;
    if (done && (count !== part.manifest.count || bytes !== part.manifest.bytes || d.chainDigest !== part.manifest.digest ||
        (job.authorAliases ?? []).some(a => !seenAliases.includes(a.sourceAuthor)))) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    await ctx.db.insert('coldHistoryChunks', { archiveId: job.archiveId, jobId: job._id, ...d,
      signature: part.chunkSignature, storageId: args.storageId, cumulativeBytes: bytes });
    await ctx.db.patch(job._id, { chunkCount: job.chunkCount + 1, count, bytes, chainDigest: d.chainDigest, seenAliases,
      phase: done ? 'VERIFY_TARGET' : 'IMPORT_STAGE', revision: job.revision + 1, updatedAt: Date.now() });
    return args.storageId;
  },
});
export const acceptPart = action({
  args: { ...jobArgs, fileJson: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const { fileJson, ...ownerJob } = args;
    const job: Job = await ctx.runQuery(queryRef('coldHistoryChunks/jobData'), ownerJob);
    if (job.kind !== 'import') throw new Error('COLD_HISTORY_JOB_KIND_MISMATCH');
    const part = await validateColdPart(JSON.parse(fileJson), job.expectedFingerprint!);
    if (await digest(part.manifest) !== await digest(job.fileRoot.manifest) || part.publicKey !== job.fileRoot.publicKey || part.signature !== job.fileRoot.signature)
      throw new Error('COLD_HISTORY_CHUNK_CONFLICT');
    if (part.descriptor.index < job.chunkCount) {
      const saved: Doc<'coldHistoryChunks'> | null = await ctx.runQuery(queryRef('coldHistoryChunks/importedPart'), { ...ownerJob, index: part.descriptor.index });
      if (!saved || saved.digest !== part.descriptor.digest || saved.chainDigest !== part.descriptor.chainDigest) throw new Error('COLD_HISTORY_CHUNK_CONFLICT');
      return view(job);
    }
    if (job.state !== 'RUNNING' || job.phase !== 'IMPORT_STAGE') throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const storageId = await ctx.storage.store(new Blob([JSON.stringify(part.payload)], { type: 'application/json' }));
    let publicationPending = false;
    try {
      const object = await ctx.storage.get(storageId);
      if (!object || object.size !== part.descriptor.bytes || await digest(JSON.parse(await object.text())) !== part.descriptor.digest)
        throw new Error('COLD_HISTORY_INTEGRITY_FAILED');
      publicationPending = true;
      await ctx.runMutation(mutationRef('coldHistoryChunks/saveImportPart'), { ...args, storageId, revision: job.revision });
      publicationPending = false;
    } catch (error) {
      if (!publicationPending) await ctx.storage.delete(storageId);
      throw error;
    }
    return view(await ctx.runQuery(queryRef('coldHistoryChunks/jobData'), ownerJob));
  },
});
export const importedPart = internalQuery({
  args: { ...jobArgs, index: v.number(), fileJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args);
    return ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', job.archiveId).eq('index', args.index)).unique();
  },
});
export const saveTargetVerification = internalMutation({
  args: { ...jobArgs, revision: v.number(), pageDigest: v.string() },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args); await stable(ctx);
    if (job.kind !== 'import' || job.state !== 'RUNNING' || job.phase !== 'VERIFY_TARGET' || job.revision !== args.revision)
      throw new Error('COLD_HISTORY_CHECKPOINT_CHANGED');
    const page = await capturePage(ctx, job);
    if (await digest(page) !== args.pageDigest) throw new Error('COLD_HISTORY_SOURCE_CHANGED');
    for (const m of page.messages) {
      const saved = await ctx.db.query('coldHistoryMessageIds').withIndex('job_message', q => q.eq('jobId', job._id).eq('messageId', m.messageId)).unique();
      if (!saved || saved.targetSeen || saved.expectedHash !== await digest({ messageId: m.messageId, text: m.text, author: m.authorGlobalId ?? m.authorPlayerId }))
        throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
      await ctx.db.patch(saved._id, { targetSeen: true });
    }
    const count = job.messageOffset + page.messages.length;
    if (count > job.count || (page.done && (count !== job.count ||
        (job.source.kind === 'travel' ? count !== job.source.expectedCount : count < job.source.expectedCount))))
      throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
    await ctx.db.patch(job._id, { messageOffset: count, pageNumber: page.pageNumber,
      cursor: page.done ? null : page.cursor, phase: page.done ? 'VERIFY' : 'VERIFY_TARGET', revision: job.revision + 1, updatedAt: Date.now() });
  },
});
export const fail = internalMutation({
  args: { ...jobArgs, revision: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args);
    if (terminal.has(job.state) || job.revision !== args.revision) return;
    await ctx.db.patch(job._id, { state: 'FAILED', error: args.error.slice(0, 1000), revision: job.revision + 1, updatedAt: Date.now() });
  },
});
export const resume = mutation({ args: jobArgs, handler: async (ctx, args) => {
  const job = await owned(ctx, args); await stable(ctx);
  if (job.state === 'FAILED') await ctx.db.patch(job._id, { state: 'RUNNING', error: undefined, revision: job.revision + 1, updatedAt: Date.now() });
  return view((await ctx.db.get(job._id))!);
} });
export const cancel = mutation({ args: jobArgs, handler: async (ctx, args) => {
  const job = await owned(ctx, args);
  if (terminal.has(job.state)) return view(job);
  // Keep pending objects for a lost response or a concurrent action. They have no
  // verified index and cancellation never deletes any original hot history.
  await release(ctx, job, 'CANCELLED');
  await ctx.db.patch(job.archiveId, { jobId: undefined, lookupKey: undefined,
    sourceKey: JSON.stringify(['cancelled-cold-history', job._id]) });
  return view((await ctx.db.get(job._id))!);
} });
export const advance = action({
  args: jobArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const job: Job = await ctx.runQuery(queryRef('coldHistoryChunks/jobData'), args);
    if (terminal.has(job.state)) return view(job);
    if (job.state === 'FAILED') throw new Error('RESUME_COLD_HISTORY_JOB_FIRST');
    const stored: Id<'_storage'>[] = []; let publicationPending = false;
    try {
      if (job.phase === 'CAPTURE') {
        const page: Awaited<ReturnType<typeof capturePage>> = await ctx.runQuery(queryRef('coldHistoryChunks/pageData'), args);
        const chunks: { payload: ChunkPayload; descriptor: ColdChunkDescriptor; storageId: Id<'_storage'> }[] = [];
        let batch: Payload['messages'] = [], count = job.count, chain = job.chainDigest;
        const flush = async () => {
          if (!batch.length) return;
          const payload: ChunkPayload = { format: 'ai-town-cold-history-chunk', version: 2,
            sourceKey: job.source.sourceKey, snapshotId: job.snapshotId, index: job.chunkCount + chunks.length,
            start: count, messages: batch,
            ...(job.source.kind === 'travel' ? { sourcePageNumber: job.pageNumber } : {}) };
          if (coldBytes(payload) > COLD_CHUNK_MAX_BYTES) throw new Error('COLD_HISTORY_SINGLE_MESSAGE_BUDGET');
          const d = await describeColdChunk(payload, chain), storageId = await ctx.storage.store(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
          stored.push(storageId); chunks.push({ payload, descriptor: d, storageId }); count += batch.length; chain = d.chainDigest; batch = [];
        };
        for (const message of page.messages) {
          if (batch.length && (batch.length === COLD_CHUNK_MAX_MESSAGES || coldBytes([...batch, message]) > COLD_CHUNK_TARGET_BYTES)) await flush();
          batch.push(message);
        }
        await flush(); publicationPending = true;
        await ctx.runMutation(mutationRef('coldHistoryChunks/savePage'), { ...args, revision: job.revision, pageDigest: await digest(page), chunks });
        publicationPending = false;
      } else if (job.phase === 'VERIFY_TARGET') {
        const page = await ctx.runQuery(queryRef('coldHistoryChunks/pageData'), args);
        await ctx.runMutation(mutationRef('coldHistoryChunks/saveTargetVerification'), { ...args, revision: job.revision, pageDigest: await digest(page) });
      } else if (job.phase === 'IMPORT_STAGE') {
        return view(job);
      } else if (job.phase === 'VERIFY') {
        const data: { chunk: Doc<'coldHistoryChunks'>; archive: Doc<'coldHistoryArchives'> } = await ctx.runQuery(queryRef('coldHistoryChunks/verifyData'), args);
        await loadChunkPayload(ctx, data.archive, data.chunk, false);
        await ctx.runMutation(mutationRef('coldHistoryChunks/saveVerified'), { ...args, revision: job.revision, index: data.chunk.index, contentDigest: data.chunk.digest });
      } else if (job.phase === 'PUBLISH') {
        await ctx.runMutation(mutationRef('coldHistoryChunks/publish'), { ...args, revision: job.revision });
      } else throw new Error('COLD_HISTORY_CHECKPOINT_INVALID');
    } catch (error) {
      if (!publicationPending) for (const id of stored) await ctx.storage.delete(id);
      if (!String(error).includes('COLD_HISTORY_CHECKPOINT_CHANGED'))
        await ctx.runMutation(mutationRef('coldHistoryChunks/fail'), { ...args, revision: job.revision, error: String(error) });
    }
    return view(await ctx.runQuery(queryRef('coldHistoryChunks/jobData'), args));
  },
});
export async function loadChunkPayload(ctx: ActionCtx, archive: Doc<'coldHistoryArchives'>, row: Doc<'coldHistoryChunks'>, verifyRoot = true) {
  const m = archive.manifest as ChunkManifest, d = descriptor(row);
  if (verifyRoot) await validateChunkRoot(m, archive.signature, archive.publicKey);
  const blob = await ctx.storage.get(row.storageId);
  if (!blob) throw new Error('COLD_HISTORY_STORAGE_MISSING');
  if (blob.size !== d.bytes || blob.size > COLD_CHUNK_MAX_BYTES) throw new Error('COLD_HISTORY_BYTES_MISMATCH');
  const payload: ChunkPayload = JSON.parse(await blob.text());
  if (payload.sourceKey !== archive.sourceKey || payload.snapshotId !== m.snapshotId || payload.index !== d.index || payload.start !== d.start ||
      payload.format !== 'ai-town-cold-history-chunk' || payload.version !== 2 || payload.messages.length !== d.count ||
      await digest(await describeColdChunk(payload, d.previousDigest)) !== await digest(d) ||
      !(await verifySignature(chunkCertificate(m.sourceKey, m.snapshotId, d), row.signature, archive.publicKey)))
    throw new Error('COLD_HISTORY_INTEGRITY_FAILED');
  validateColdMessages(payload.messages, archive.kind);
  return payload;
}
export const chunkData = internalQuery({
  args: { ...ownerArgs, index: v.number() },
  handler: async (ctx, args) => {
    const s = await source(ctx, args), archive = await archiveFor(ctx, s.sourceKey);
    if (!archive || archive.state !== 'VERIFIED' || archive.manifest.version !== 2) throw new Error('COLD_HISTORY_NOT_VERIFIED');
    if (!Number.isSafeInteger(args.index) || args.index < 0 || args.index >= archive.manifest.chunkCount) throw new Error('INVALID_COLD_HISTORY_PART');
    const chunk = await ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', archive._id).eq('index', args.index)).unique();
    if (!chunk) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    return { archive, chunk };
  },
});
export const exportPart = action({
  args: { ...ownerArgs, index: v.number() },
  handler: async (ctx, args): Promise<PortableColdPart> => {
    requireAdmin(args.adminToken);
    const data: { archive: Doc<'coldHistoryArchives'>; chunk: Doc<'coldHistoryChunks'> } = await ctx.runQuery(queryRef('coldHistoryChunks/chunkData'), args);
    const payload = await loadChunkPayload(ctx, data.archive, data.chunk);
    const part: PortableColdPart = { format: 'ai-town-cold-history-part', version: 2,
      manifest: data.archive.manifest, signature: data.archive.signature, publicKey: data.archive.publicKey,
      descriptor: descriptor(data.chunk), chunkSignature: data.chunk.signature, payload };
    return validateColdPart(part, `sha256:${await digest(part.publicKey)}`);
  },
});
export const exportHeader = action({
  args: ownerArgs,
  handler: async (ctx, args): Promise<PortableColdRoot> => {
    requireAdmin(args.adminToken);
    const archive: Doc<'coldHistoryArchives'> = await ctx.runQuery(queryRef('coldHistory/readData'), args);
    if (archive.manifest.version !== 2) throw new Error('COLD_HISTORY_USE_V1_FILE_EXPORT');
    await validateChunkRoot(archive.manifest, archive.signature, archive.publicKey);
    return { format: 'ai-town-cold-history-manifest', version: 2, manifest: archive.manifest,
      publicKey: archive.publicKey, signature: archive.signature };
  },
});
export const pageChunks = internalQuery({
  args: { archiveId: v.id('coldHistoryArchives'), offset: v.number(), numItems: v.number() },
  handler: async (ctx, args) => {
    const archive = await ctx.db.get(args.archiveId);
    if (!archive || archive.state !== 'VERIFIED' || archive.manifest.version !== 2) throw new Error('COLD_HISTORY_NOT_VERIFIED');
    const first = await ctx.db.query('coldHistoryChunks').withIndex('archive_start', q => q.eq('archiveId', archive._id).lte('start', args.offset)).order('desc').first();
    if (args.offset === archive.manifest.count) return [];
    if (!first || first.start + first.count <= args.offset) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    return ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', archive._id).gte('index', first.index)).take(args.numItems + 1);
  },
});
