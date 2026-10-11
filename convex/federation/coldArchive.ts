import { v } from 'convex/values';
import { action, mutation, query, internalQuery, internalMutation } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { identity } from './store';
import { digest, requireAdmin } from './security';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  configuredS3,
  destination,
  mirrorKey,
  rawSha256,
  safeArchiveError,
  s3Configurations,
} from './coldArchivePolicy';
import { load } from './coldHistory';
import { loadChunkPayload } from './coldHistoryChunks';
import { validateChunkRoot } from './coldHistoryChunkFormat';

const jobArgs = { adminToken: v.string(), jobId: v.id('coldArchiveMirrorJobs') };
const scopeFor = (local: Doc<'federationIdentity'>) => ({
  townId: local.townId,
  publicKey: local.publicKey,
  deploymentInstanceId: local.deploymentInstanceId,
  deploymentEpoch: local.deploymentEpoch,
  identityVersion: local.identityVersion ?? 1,
});
async function environment(name: string) {
  const config = configuredS3(name);
  return {
    public: destination(config),
    binding: await rawSha256(
      JSON.stringify([
        config.name,
        config.endpoint,
        config.region,
        config.bucket,
        config.prefix,
        config.accessKeyId,
        config.secretAccessKey,
        config.sessionToken ?? null,
      ]),
    ),
  };
}
function operatorLabel(operator: string) {
  if (!operator.trim() || operator.length > 100) throw new Error('COLD_ARCHIVE_OPERATOR_REQUIRED');
}
async function archiveBinding(archive: Doc<'coldHistoryArchives'>) {
  return digest({
    id: archive._id,
    manifest: archive.manifest,
    signature: archive.signature,
    publicKey: archive.publicKey,
    storageId: archive.storageId,
  });
}
async function current(ctx: QueryCtx | MutationCtx, id: Id<'coldArchiveMirrorJobs'>) {
  const job = await ctx.db.get(id);
  if (!job) throw new Error('COLD_ARCHIVE_JOB_NOT_FOUND');
  const local = await identity(ctx),
    target = await ctx.db.get(job.destinationId),
    archive = await ctx.db.get(job.archiveId);
  if (
    !local ||
    local.mode !== 'ACTIVE' ||
    (await digest(scopeFor(local))) !== (await digest(job.identityScope))
  )
    throw new Error('COLD_ARCHIVE_IDENTITY_CHANGED');
  if (
    !target?.enabled ||
    target.state !== 'VERIFIED' ||
    target.revision !== job.destinationRevision ||
    target.environmentBinding !== job.environmentBinding
  )
    throw new Error('COLD_ARCHIVE_DESTINATION_CHANGED');
  if (
    !archive ||
    archive.state !== 'VERIFIED' ||
    (await archiveBinding(archive)) !== job.archiveBinding
  )
    throw new Error('COLD_ARCHIVE_SOURCE_CHANGED');
  return { job, target, archive };
}
function view(job: Doc<'coldArchiveMirrorJobs'>) {
  return {
    jobId: job._id,
    archiveId: job.archiveId,
    destinationId: job.destinationId,
    state: job.state,
    nextIndex: job.nextIndex,
    partCount: job.partCount,
    verifiedBytes: job.verifiedBytes,
    revision: job.revision,
    updatedAt: job.updatedAt,
    error: job.error,
    localOriginalsRetained: true as const,
  };
}

export const status = query({
  args: { adminToken: v.string(), archiveId: v.optional(v.id('coldHistoryArchives')) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const jobs = args.archiveId
      ? await ctx.db
          .query('coldArchiveMirrorJobs')
          .withIndex('archive', (q) => q.eq('archiveId', args.archiveId!))
          .order('desc')
          .take(20)
      : await ctx.db.query('coldArchiveMirrorJobs').order('desc').take(20);
    return {
      configured: s3Configurations().map(destination),
      destinations: await ctx.db.query('coldArchiveDestinations').take(16),
      jobs: jobs.map(view),
    };
  },
});

export const archives = query({
  args: { adminToken: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const result = await ctx.db
      .query('coldHistoryArchives')
      .order('desc')
      .paginate({ cursor: args.cursor, numItems: 20, maximumBytesRead: 200_000 });
    return {
      ...result,
      page: result.page
        .filter((archive) => archive.state === 'VERIFIED')
        .map((archive) => ({
          archiveId: archive._id,
          kind: archive.kind,
          sourceId: archive.sourceId,
          createdAt: archive.createdAt,
          version: archive.manifest.version,
          count: archive.manifest.count,
        })),
    };
  },
});

export const configure = mutation({
  args: { adminToken: v.string(), name: v.string(), enabled: v.boolean(), operator: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    operatorLabel(args.operator);
    const config = await environment(args.name);
    const previous = await ctx.db
      .query('coldArchiveDestinations')
      .withIndex('name', (q) => q.eq('name', args.name))
      .unique();
    if (!previous && (await ctx.db.query('coldArchiveDestinations').take(16)).length >= 16)
      throw new Error('COLD_ARCHIVE_DESTINATION_LIMIT');
    const fields = {
      ...config.public,
      enabled: args.enabled,
      state: 'UNVERIFIED' as const,
      revision: (previous?.revision ?? 0) + 1,
      environmentBinding: config.binding,
      operator: args.operator.trim(),
      updatedAt: Date.now(),
      createdAt: previous?.createdAt ?? Date.now(),
    };
    if (previous) {
      await ctx.db.replace(previous._id, fields);
      return previous._id;
    }
    return ctx.db.insert('coldArchiveDestinations', fields);
  },
});

export const verificationData = internalQuery({
  args: { destinationId: v.id('coldArchiveDestinations') },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.destinationId),
      local = await identity(ctx);
    if (!target?.enabled || !local || local.mode !== 'ACTIVE')
      throw new Error('COLD_ARCHIVE_NOT_READY');
    return { target, scope: scopeFor(local) };
  },
});
export const saveVerification = internalMutation({
  args: {
    destinationId: v.id('coldArchiveDestinations'),
    revision: v.number(),
    binding: v.string(),
    scope: v.any(),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.destinationId),
      local = await identity(ctx);
    if (
      !target?.enabled ||
      target.revision !== args.revision ||
      target.environmentBinding !== args.binding ||
      (await environment(target.name)).binding !== args.binding ||
      !local ||
      local.mode !== 'ACTIVE' ||
      (await digest(scopeFor(local))) !== (await digest(args.scope))
    )
      throw new Error('COLD_ARCHIVE_CHECKPOINT_CHANGED');
    await ctx.db.patch(target._id, {
      state: 'VERIFIED',
      verifiedAt: Date.now(),
      verifiedScope: scopeFor(local),
    });
  },
});
export const verify = action({
  args: { adminToken: v.string(), destinationId: v.id('coldArchiveDestinations') },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const data: { target: Doc<'coldArchiveDestinations'>; scope: ReturnType<typeof scopeFor> } =
      await ctx.runQuery(queryRef('coldArchive/verificationData'), {
        destinationId: args.destinationId,
      });
    const config = await environment(data.target.name);
    if (config.binding !== data.target.environmentBinding)
      throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
    const result: { ok: boolean; error?: string } = await ctx.runAction(
      actionRef('coldArchiveNode/putVerified'),
      {
        name: data.target.name,
        environmentBinding: config.binding,
        scope: await rawSha256(JSON.stringify(data.scope)),
        runId: `probe-${crypto.randomUUID()}`,
        index: 'root',
        body: JSON.stringify({ format: 'ai-town-storage-probe', nonce: crypto.randomUUID() }),
      },
    );
    if (!result.ok) throw new Error(result.error ?? 'COLD_ARCHIVE_VERIFY_FAILED');
    await ctx.runMutation(mutationRef('coldArchive/saveVerification'), {
      destinationId: args.destinationId,
      revision: data.target.revision,
      binding: config.binding,
      scope: data.scope,
    });
    return { verified: true };
  },
});

export const start = mutation({
  args: {
    adminToken: v.string(),
    archiveId: v.id('coldHistoryArchives'),
    destinationId: v.id('coldArchiveDestinations'),
    operator: v.string(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    operatorLabel(args.operator);
    const local = await identity(ctx),
      target = await ctx.db.get(args.destinationId),
      archive = await ctx.db.get(args.archiveId);
    if (
      !local ||
      local.mode !== 'ACTIVE' ||
      !target?.enabled ||
      target.state !== 'VERIFIED' ||
      (await digest(scopeFor(local))) !== (await digest(target.verifiedScope))
    )
      throw new Error('COLD_ARCHIVE_NOT_READY');
    if (!archive || archive.state !== 'VERIFIED' || ![1, 2].includes(archive.manifest.version))
      throw new Error('COLD_ARCHIVE_SOURCE_NOT_VERIFIED');
    const config = await environment(target.name);
    if (config.binding !== target.environmentBinding)
      throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
    const partCount = archive.manifest.version === 2 ? archive.manifest.chunkCount : 0;
    if (!Number.isSafeInteger(partCount) || partCount < 0)
      throw new Error('COLD_ARCHIVE_INVALID_PART_COUNT');
    const root = {
      format:
        archive.manifest.version === 2
          ? 'ai-town-cold-history-manifest'
          : 'ai-town-cold-history-file',
      version: archive.manifest.version,
      manifest: archive.manifest,
      signature: archive.signature,
      publicKey: archive.publicKey,
    };
    return ctx.db.insert('coldArchiveMirrorJobs', {
      destinationId: target._id,
      destinationRevision: target.revision,
      environmentBinding: config.binding,
      identityScope: scopeFor(local),
      archiveId: archive._id,
      archiveBinding: await archiveBinding(archive),
      runId: crypto.randomUUID(),
      keyScope: await rawSha256(JSON.stringify(scopeFor(local))),
      root,
      state: 'RUNNING',
      revision: 0,
      nextIndex: 0,
      partCount,
      verifiedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      operator: args.operator.trim(),
    });
  },
});

export const pageData = internalQuery({
  args: { jobId: v.id('coldArchiveMirrorJobs') },
  handler: async (ctx, args) => {
    const data = await current(ctx, args.jobId);
    if (!['RUNNING', 'FAILED'].includes(data.job.state))
      throw new Error('COLD_ARCHIVE_JOB_TERMINAL');
    const chunk =
      data.job.nextIndex < data.job.partCount
        ? await ctx.db
            .query('coldHistoryChunks')
            .withIndex('archive_index', (q) =>
              q.eq('archiveId', data.archive._id).eq('index', data.job.nextIndex),
            )
            .unique()
        : null;
    if (data.job.nextIndex < data.job.partCount && !chunk)
      throw new Error('COLD_ARCHIVE_PART_MISSING');
    return { ...data, chunk };
  },
});
export const savePage = internalMutation({
  args: {
    jobId: v.id('coldArchiveMirrorJobs'),
    revision: v.number(),
    key: v.string(),
    sha256: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const { job, target } = await current(ctx, args.jobId);
    if (!['RUNNING', 'FAILED'].includes(job.state) || job.revision !== args.revision)
      throw new Error('COLD_ARCHIVE_CHECKPOINT_CHANGED');
    if ((await environment(target.name)).binding !== job.environmentBinding)
      throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
    const expectedKey = mirrorKey(
      target.prefix,
      job.keyScope,
      job.runId,
      job.nextIndex === job.partCount ? 'root' : job.nextIndex,
    );
    if (args.key !== expectedKey) throw new Error('COLD_ARCHIVE_INVALID_RECEIPT');
    if (
      !Number.isSafeInteger(args.bytes) ||
      args.bytes < 1 ||
      args.bytes > 2_000_000 ||
      !/^[a-f0-9]{64}$/.test(args.sha256)
    )
      throw new Error('COLD_ARCHIVE_INVALID_RECEIPT');
    await ctx.db.insert('coldArchiveMirrorObjects', {
      jobId: job._id,
      index: job.nextIndex,
      key: args.key,
      sha256: args.sha256,
      bytes: args.bytes,
      verifiedAt: Date.now(),
    });
    await ctx.db.patch(job._id, {
      nextIndex: job.nextIndex + 1,
      revision: job.revision + 1,
      state: job.nextIndex === job.partCount ? 'COMPLETE' : 'RUNNING',
      error: undefined,
      verifiedBytes: job.verifiedBytes + args.bytes,
      updatedAt: Date.now(),
    });
    return view((await ctx.db.get(job._id))!);
  },
});
export const failPage = internalMutation({
  args: { jobId: v.id('coldArchiveMirrorJobs'), revision: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job && ['RUNNING', 'FAILED'].includes(job.state) && job.revision === args.revision)
      await ctx.db.patch(job._id, {
        state: 'FAILED',
        error: safeArchiveError(new Error(args.error)),
        revision: job.revision + 1,
        updatedAt: Date.now(),
      });
  },
});
export const advance = action({
  args: jobArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const data: {
      job: Doc<'coldArchiveMirrorJobs'>;
      target: Doc<'coldArchiveDestinations'>;
      archive: Doc<'coldHistoryArchives'>;
      chunk: Doc<'coldHistoryChunks'> | null;
    } = await ctx.runQuery(queryRef('coldArchive/pageData'), { jobId: args.jobId });
    try {
      if ((await environment(data.target.name)).binding !== data.job.environmentBinding)
        throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
      let object: unknown;
      if (data.chunk) {
        const payload = await loadChunkPayload(ctx, data.archive, data.chunk);
        const {
          index,
          start,
          count,
          bytes,
          digest: partDigest,
          previousDigest,
          chainDigest,
        } = data.chunk;
        object = {
          format: 'ai-town-cold-history-part',
          version: 2,
          manifest: data.archive.manifest,
          signature: data.archive.signature,
          publicKey: data.archive.publicKey,
          descriptor: {
            index,
            start,
            count,
            bytes,
            digest: partDigest,
            previousDigest,
            chainDigest,
          },
          chunkSignature: data.chunk.signature,
          payload,
        };
      } else if (data.archive.manifest.version === 1) {
        object = { ...data.job.root, payload: await load(ctx, data.archive) };
      } else {
        await validateChunkRoot(
          data.archive.manifest,
          data.archive.signature,
          data.archive.publicKey,
        );
        object = data.job.root;
      }
      const body = JSON.stringify(object);
      const result: { ok: boolean; key?: string; sha256?: string; bytes?: number; error?: string } =
        await ctx.runAction(actionRef('coldArchiveNode/putVerified'), {
          name: data.target.name,
          environmentBinding: data.job.environmentBinding,
          scope: data.job.keyScope,
          runId: data.job.runId,
          index: data.chunk ? data.job.nextIndex : 'root',
          body,
        });
      if (
        !result.ok ||
        !result.key ||
        result.sha256 !== (await rawSha256(body)) ||
        result.bytes !== new TextEncoder().encode(body).length
      )
        throw new Error(result.error ?? 'COLD_ARCHIVE_READBACK_MISMATCH');
      return await ctx.runMutation(mutationRef('coldArchive/savePage'), {
        jobId: data.job._id,
        revision: data.job.revision,
        key: result.key,
        sha256: result.sha256,
        bytes: result.bytes,
      });
    } catch (error) {
      const code = safeArchiveError(error);
      await ctx.runMutation(mutationRef('coldArchive/failPage'), {
        jobId: data.job._id,
        revision: data.job.revision,
        error: code,
      });
      throw new Error(code);
    }
  },
});
export const cancel = mutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error('COLD_ARCHIVE_JOB_NOT_FOUND');
    if (job.state === 'COMPLETE' || job.state === 'CANCELLED') return view(job);
    await ctx.db.patch(job._id, {
      state: 'CANCELLED',
      revision: job.revision + 1,
      updatedAt: Date.now(),
    });
    return view((await ctx.db.get(job._id))!);
  },
});
