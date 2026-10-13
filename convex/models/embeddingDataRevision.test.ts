import { convexTest } from 'convex-test';
import schema from '../schema';
import { dataRevision, archiveReferenceRevisionKey, privacyRevisionKey, sourceKey, withEmbeddingRevision } from './embeddingDataRevision';

const modules = { '../_generated/server.ts': () => import('../_generated/server') };

test.each(['job metadata', 'chunk descriptor', 'resident mapping'] as const)(
  'registered %s changes invalidate a privacy plan without changing canonical memory revision', async kind => {
    const t = convexTest(schema, modules);
    await t.run(async ctx => {
      const job = { kind: 'import' as const, state: 'COMPLETE', phase: 'DONE', tableIndex: 0, cursor: null,
        chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0, createdAt: 1, updatedAt: 1, source: {} };
      const jobId = await ctx.db.insert('backupLargeJobs', job);
      const storageId = await ctx.storage.store(new Blob(['{}']));
      const db = withEmbeddingRevision(ctx).db;
      const before = await dataRevision(ctx.db, privacyRevisionKey);
      const canonical = await dataRevision(ctx.db, sourceKey);
      if (kind === 'job metadata') {
        const id = await db.insert('backupLargeJobs', job);
        await db.patch(id, { state: 'CANCELLED' });
        await db.replace(id, { ...job, source: { sourceTownId: 'changed' } });
        await db.delete(id);
      } else if (kind === 'chunk descriptor') {
        const row = { jobId, storageId, index: 0, table: 'memories', count: 0, bytes: 2, digest: 'fixture-digest' };
        const id = await db.insert('backupLargeChunks', row);
        await db.patch(id, { count: 1 });
        await db.replace(id, { ...row, table: 'inputs' });
        await db.delete(id);
      } else {
        const row = { jobId, sourceId: 'source-resident', targetId: 'first-resident' };
        const id = await db.insert('backupLargeGlobalMappings', row);
        await db.patch(id, { targetId: 'other-resident' });
        await db.replace(id, { ...row, sourceId: 'other-source' });
        await db.delete(id);
      }
      expect(await dataRevision(ctx.db, privacyRevisionKey)).toBe(before + 4);
      expect(await dataRevision(ctx.db, sourceKey)).toBe(canonical);
    });
  },
);


test.each(['music', 'upload', 'nested import'] as const)('archive reference epoch covers %s publication, replacement and removal', async kind => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    const db = withEmbeddingRevision(ctx).db;
    const before = await dataRevision(ctx.db, archiveReferenceRevisionKey);
    const canonical = await dataRevision(ctx.db, sourceKey);
    if (kind === 'music') {
      const row = { type: 'background' as const, storageId: 'first-storage' };
      const id = await db.insert('music', row);
      await db.patch(id, { storageId: 'second-storage' });
      await db.replace(id, { ...row, storageId: 'third-storage' });
      await db.delete(id);
    } else if (kind === 'upload') {
      const row = { producerKind: 'LARGE_CHUNK' as const, ownerKey:'owner',operationKey:'attempt',state:'RESERVED' as const,
        revision:1,contentType:'marker',sha256Hex:'0'.repeat(64),size:2,uploadAcknowledged:false,recoveryRevision:0,
        recoveryCursor:null,recoveryPasses:0,recoveryConflict:false,createdAt:1,updatedAt:1 };
      const id = await db.insert('archiveUploadOperations', row);
      await db.patch(id, { state:'UPLOADING' });
      await db.replace(id, { ...row, state:'RETIRED' });
      await db.delete(id);
    } else {
      const row = { sourceTownId:'source',mode:'clone',exportedAt:1,importedAt:2,mapping:{},manifest:{},runtimeSnapshot:{} };
      const id = await db.insert('backupImports',row);
      await db.patch(id,{ runtimeSnapshot:{ OLD:[{ unfamiliarAlias:'first-storage' }] } });
      await db.replace(id,{ ...row,manifest:{ nested:{ unfamiliarAlias:'second-storage' } } });
      await db.delete(id);
    }
    expect(await dataRevision(ctx.db, archiveReferenceRevisionKey)).toBe(before+4);
    expect(await dataRevision(ctx.db, sourceKey)).toBe(canonical);
  });
});

test('reference epoch rolls back with a failed pointer publication and unrelated memory access does not invalidate it', async () => {
  const t=convexTest(schema,modules);
  await expect(t.run(async ctx => {
    await withEmbeddingRevision(ctx).db.insert('music',{ type:'background',storageId:'rollback-storage' });
    throw new Error('ROLLBACK_PUBLICATION');
  })).rejects.toThrow('ROLLBACK_PUBLICATION');
  expect(await t.run(ctx=>dataRevision(ctx.db,archiveReferenceRevisionKey))).toBe(0);
  expect(await t.run(ctx=>ctx.db.query('music').collect())).toEqual([]);
  await t.run(async ctx=>{
    const id=await ctx.db.insert('memories',{playerId:'p:0',description:'retained',importance:1,lastAccess:1,
      data:{type:'reflection',relatedMemoryIds:[]}});
    await withEmbeddingRevision(ctx).db.patch(id,{lastAccess:2});
    expect(await dataRevision(ctx.db,archiveReferenceRevisionKey)).toBe(0);
  });
});

test('cold mirror root aliases invalidate a paged reference proof even when memory privacy sources are unchanged', async () => {
  const t=convexTest(schema,modules);
  await t.run(async ctx=>{
    const worldId=await ctx.db.insert('worlds',{nextId:1,players:[],agents:[],conversations:[]});
    const archiveId=await ctx.db.insert('coldHistoryArchives',{sourceKey:'test',worldId,kind:'travel',sourceId:'test',
      state:'VERIFIED',manifest:{},signature:'test',publicKey:'test',createdAt:1});
    const destinationId=await ctx.db.insert('coldArchiveDestinations',{name:'fixture',endpoint:'https://fixture.invalid',region:'test',
      bucket:'fixture',prefix:'test',enabled:false,state:'UNVERIFIED',revision:1,createdAt:1,updatedAt:1,operator:'fixture'});
    const row={destinationId,destinationRevision:1,environmentBinding:'fixture',archiveId,archiveBinding:'fixture',
      identityScope:{townId:'fixture',publicKey:'fixture',deploymentInstanceId:'fixture',deploymentEpoch:1,identityVersion:1},
      runId:'fixture',keyScope:'fixture',root:{alias:'first-storage'},state:'COMPLETE' as const,revision:1,nextIndex:0,
      partCount:0,verifiedBytes:0,createdAt:1,updatedAt:1,operator:'fixture'};
    const db=withEmbeddingRevision(ctx).db;
    const privacyBefore=await dataRevision(ctx.db,privacyRevisionKey);
    const id=await db.insert('coldArchiveMirrorJobs',row);
    const captured=await dataRevision(ctx.db,archiveReferenceRevisionKey);
    await db.patch(id,{root:{nested:{unknownAlias:'second-storage'}}});
    expect(await dataRevision(ctx.db,archiveReferenceRevisionKey)).toBe(captured+1);
    await db.replace(id,{...row,root:{alias:'third-storage'}});
    await db.delete(id);
    expect(await dataRevision(ctx.db,archiveReferenceRevisionKey)).toBe(captured+3);
    expect(await dataRevision(ctx.db,privacyRevisionKey)).toBe(privacyBefore);
  });
});
