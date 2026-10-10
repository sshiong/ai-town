import { MAX_REPLY_TIMEOUT_MS, replyTimeoutMs } from './replyPolicy';
import { v } from 'convex/values';
import { configuredResourceLimits, pendingDecisionCount } from './resources';
import { internalMutation, mutation, query, MutationCtx } from '../maintenanceFunctions';
import { Doc, Id } from '../_generated/dataModel';
import { parseGameId } from '../aiTown/ids';
import { insertInput } from '../aiTown/insertInput';
import { assertFederationAdmin } from './auth';
import { identity, peer, visit } from './store';
import { enqueueMessage } from './queue';
import { FederationMessage } from './protocol';
import { actionRef } from './refs';
import { makeFunctionReference } from 'convex/server';
import { bindResident } from '../models/profiles';
import { recordConfirmedObservation } from '../agent/travelMemory';
import { receiveConversationEnded } from '../agent/travelTranscript';
import { homeFrozen, hostCreated, hostRemoved, homeResumed } from './ledger';
import type { InputNames, InputArgs } from '../aiTown/inputs';

export async function syncResidentRuntimes(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const local = await identity(ctx);
  const world = await ctx.db.get(worldId);
  if (!world) return;
  for (const agent of world.agents) {
    const binding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', worldId).eq('playerId', agent.playerId))
      .unique();
    const globalId =
      binding?.agentGlobalId ??
      (local ? `${local.townId}/agent:${worldId}:${agent.id}` : undefined);
    await bindResident(ctx, worldId, parseGameId('players', agent.playerId), globalId);
    if (!local || !globalId) continue;
    const existing = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', globalId))
      .unique();
    if (!existing)
      await ctx.db.insert('federationAgentRuntimes', {
        agentGlobalId: globalId,
        homeTownId: local.townId,
        worldId,
        playerId: agent.playerId,
        agentId: agent.id,
        state: agent.travelVisitId ? 'TRAVELING' : 'HOME_ACTIVE',
        visitId: agent.travelVisitId,
        agentAuthorityEpoch: 1,
        updatedAt: Date.now(),
      });
  }
}
export const initializeResidents = mutation({
  args: { adminToken: v.string(), worldId: v.optional(v.id('worlds')) },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    if (!(await identity(ctx))) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const worlds = args.worldId
      ? [await ctx.db.get(args.worldId)]
      : await ctx.db.query('worlds').collect();
    for (const world of worlds) if (world) await syncResidentRuntimes(ctx, world._id);
  },
});
export const listResidents = query({
  args: { adminToken: v.string(), worldId: v.optional(v.id('worlds')) },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const residents = await ctx.db.query('federationAgentRuntimes').take(100);
    return await Promise.all(
      residents
        .filter((r) => !args.worldId || r.worldId === args.worldId)
        .map(async (r) => {
          const description = await ctx.db
            .query('playerDescriptions')
            .withIndex('worldId', (q) => q.eq('worldId', r.worldId).eq('playerId', r.playerId))
            .unique();
          return {
            ...r,
            name: description?.name ?? r.playerId,
            character: description?.character,
            description: description?.description,
          };
        }),
    );
  },
});
export const worldPresence = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const residents = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('world', (q) => q.eq('worldId', args.worldId))
      .collect();
    const travelers = [];
    for (const r of residents.filter((r) => r.state !== 'HOME_ACTIVE')) {
      const ledger = r.visitId ? await visit(ctx, r.visitId) : null;
      travelers.push({
        playerId: r.playerId,
        name: descriptions.find((d) => d.playerId === r.playerId)?.name ?? r.playerId,
        agentGlobalId: r.agentGlobalId,
        state: r.state,
        visitId: r.visitId,
        hostTownId: ledger?.hostTownId,
        leaseExpiry: ledger?.leaseExpiry,
        lastError: r.lastError,
      });
    }
    return {
      visitors: (world?.players ?? [])
        .filter((p) => p.remoteVisitor)
        .map((p) => ({
          playerId: p.id,
          name: descriptions.find((d) => d.playerId === p.id)?.name ?? p.id,
          ...p.remoteVisitor!,
        })),
      travelers,
    };
  },
});

async function schedulePresence<Name extends InputNames>(
  ctx: MutationCtx,
  visitId: string,
  kind: string,
  worldId: Id<'worlds'>,
  name: Name,
  args: InputArgs<Name>,
) {
  const old = await ctx.db
    .query('federationPresenceJobs')
    .withIndex('visit_kind', (q) => q.eq('visitId', visitId).eq('kind', kind))
    .unique();
  if (old && old.state !== 'FAILED') return;
  const status = await ctx.db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (!status || status.status === 'stoppedByDeveloper') throw new Error('WORLD_NOT_RUNNING');
  // Wake an idle world through its normal heartbeat/start path.
  if (status.status === 'inactive') {
    const { startEngine } = await import('../aiTown/main');
    await ctx.db.patch(status._id, { status: 'running' });
    await startEngine(ctx, worldId);
  }
  const inputId = await insertInput(ctx, worldId, name, args);
  const job = { visitId, kind, inputId, state: 'PENDING', createdAt: Date.now() };
  if (old) await ctx.db.replace(old._id, job);
  else await ctx.db.insert('federationPresenceJobs', job);
}
export const freezeHome = internalMutation({
  args: { visitId: v.string() },
  handler: async (ctx, { visitId }) => {
    const ledger = await visit(ctx, visitId);
    if (!ledger || ledger.role !== 'home' || !ledger.worldId || !ledger.homePlayerId)
      throw new Error('INVALID_HOME_VISIT');
    if (ledger.state !== 'FREEZING') return;
    const runtime = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', ledger.agentGlobalId))
      .unique();
    if (!runtime) throw new Error('RUNTIME_NOT_FOUND');
    await ctx.db.patch(runtime._id, {
      state: 'TRAVEL_PREPARING',
      visitId,
      agentAuthorityEpoch: ledger.agentAuthorityEpoch,
      updatedAt: Date.now(),
    });
    await schedulePresence(ctx, visitId, 'freeze', runtime.worldId, 'federationSuspend', {
      agentId: runtime.agentId,
      visitId,
    });
  },
});
export const createHostPresence = internalMutation({
  args: { visitId: v.string() },
  handler: async (ctx, { visitId }) => {
    const ledger = await visit(ctx, visitId);
    if (!ledger || ledger.role !== 'host') throw new Error('INVALID_HOST_VISIT');
    if (ledger.state !== 'CREATING' || ledger.leaseExpiry <= Date.now()) return;
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) throw new Error('HOST_WORLD_MISSING');
    await ctx.db.patch(ledger._id, { worldId: worldStatus.worldId });
    const profile = ledger.profile;
    const local = await identity(ctx);
    await schedulePresence(ctx, visitId, 'create', worldStatus.worldId, 'federationCreateVisitor', {
      visitor: {
        visitId,
        agentGlobalId: ledger.agentGlobalId,
        homeTownId: ledger.homeTownId,
        homeTownName: profile.homeTownName,
        agentAuthorityEpoch: ledger.agentAuthorityEpoch,
        visitLeaseVersion: ledger.visitLeaseVersion,
        leaseExpiry: ledger.leaseExpiry,
        replyTimeoutMs: replyTimeoutMs(local?.replyTimeoutMs),
        lastObservationAt: 0,
      },
      name: profile.name,
      character: profile.character,
      description: profile.description,
    });
  },
});
export const removeHostPresence = internalMutation({
  args: { visitId: v.string() },
  handler: async (ctx, { visitId }) => {
    const ledger = await visit(ctx, visitId);
    if (!ledger || ledger.role !== 'host') throw new Error('INVALID_HOST_VISIT');
    if (!ledger.worldId) {
      await hostRemoved(ctx, visitId);
      return;
    }
    await schedulePresence(ctx, visitId, 'remove', ledger.worldId, 'federationRemoveVisitor', {
      visitId,
    });
  },
});
export const updateHostLease = internalMutation({
  args: { visitId: v.string() },
  handler: async (ctx, { visitId }) => {
    const ledger = await visit(ctx, visitId);
    if (!ledger || ledger.role !== 'host' || ledger.state !== 'ACTIVE' || !ledger.worldId)
      throw new Error('VISIT_NOT_ACTIVE');
    await insertInput(ctx, ledger.worldId, 'federationUpdateLease', {
      visitId,
      agentAuthorityEpoch: ledger.agentAuthorityEpoch,
      visitLeaseVersion: ledger.visitLeaseVersion,
      leaseExpiry: ledger.leaseExpiry,
    });
  },
});
export const resumeHome = internalMutation({
  args: { visitId: v.string() },
  handler: async (ctx, { visitId }) => {
    const ledger = await visit(ctx, visitId);
    if (!ledger || ledger.role !== 'home') throw new Error('INVALID_HOME_VISIT');
    if (ledger.state !== 'RETURN_PENDING') return;
    if (!ledger.cleanupConfirmed && ledger.leaseExpiry + 60_000 > Date.now())
      throw new Error('HOST_LEASE_STILL_VALID');
    const runtime = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', ledger.agentGlobalId))
      .unique();
    if (!runtime) throw new Error('RUNTIME_NOT_FOUND');
    if (runtime.visitId !== visitId || runtime.agentAuthorityEpoch !== ledger.agentAuthorityEpoch) {
      // A delayed return for an older authority must not resume the current
      // body. Once its lease is certainly dead, close only the old ledger.
      if (runtime.agentAuthorityEpoch > ledger.agentAuthorityEpoch &&
          ledger.leaseExpiry + 60_000 <= Date.now())
        await homeResumed(ctx, visitId);
      return;
    }
    await ctx.db.patch(runtime._id, {
      state: 'RETURN_PENDING',
      updatedAt: Date.now(),
      activeDecisionId: undefined,
    });
    await schedulePresence(ctx, visitId, 'resume', runtime.worldId, 'federationResume', {
      agentId: runtime.agentId,
      visitId,
    });
  },
});

/** Engine input results and travel transitions commit in the same database transaction. */
export async function commitPresenceJobs(ctx: MutationCtx) {
  const pending = await ctx.db
    .query('federationPresenceJobs')
    .withIndex('state', (q) => q.eq('state', 'PENDING'))
    .take(100);
  for (const job of pending) {
    const input = await ctx.db.get(job.inputId);
    if (!input?.returnValue) continue;
    if (input.returnValue.kind === 'error') {
      await ctx.db.patch(job._id, { state: 'FAILED', error: input.returnValue.message });
      const ledger = await visit(ctx, job.visitId);
      if (ledger) await ctx.db.patch(ledger._id, { lastError: input.returnValue.message });
      continue;
    }
    const runtime = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('visit', (q) => q.eq('visitId', job.visitId))
      .unique();
    if (job.kind === 'freeze') {
      await homeFrozen(ctx, job.visitId);
      const current = await visit(ctx, job.visitId);
      if (runtime && current?.state === 'CONFIRMING')
        await ctx.db.patch(runtime._id, { state: 'TRAVELING', updatedAt: Date.now() });
    } else if (job.kind === 'create') {
      await hostCreated(ctx, job.visitId, String(input.returnValue.value));
    } else if (job.kind === 'remove') {
      await hostRemoved(ctx, job.visitId);
    } else if (job.kind === 'resume') {
      await homeResumed(ctx, job.visitId);
      const current = await visit(ctx, job.visitId);
      if (runtime && current?.state === 'COMPLETED')
        await ctx.db.patch(runtime._id, {
          state: 'HOME_ACTIVE',
          visitId: undefined,
          activeDecisionId: undefined,
          agentAuthorityEpoch: runtime.agentAuthorityEpoch + 1,
          updatedAt: Date.now(),
        });
    }
    await ctx.db.patch(job._id, { state: 'COMMITTED' });
  }
}

export async function collectObservations(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const world = await ctx.db.get(worldId);
  if (!world) return;
  const now = Date.now();
  const limits = await configuredResourceLimits(ctx.db);
  let pendingCount = await pendingDecisionCount(ctx.db, now);
  for (const player of world.players.filter((p) => p.remoteVisitor)) {
    const visitor = player.remoteVisitor!;
    const ledger = await visit(ctx, visitor.visitId);
    if (!ledger || ledger.state !== 'ACTIVE' || ledger.leaseExpiry <= now) continue;
    const pendingTurn = visitor.pendingTurn;
    if (!pendingTurn || pendingTurn.deadline <= now) continue;
    const existingTurn = await ctx.db
      .query('federationTurns')
      .withIndex('turn', (q) => q.eq('turnId', pendingTurn.turnId))
      .unique();
    if (existingTurn) continue;
    if (pendingCount >= limits.maxPendingDecisions) continue;
    const conversation = world.conversations.find((c) =>
      c.participants.some((m) => m.playerId === player.id),
    );
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .collect();
    const messages = conversation
      ? await ctx.db
          .query('messages')
          .withIndex('conversationId', (q) =>
            q.eq('worldId', worldId).eq('conversationId', conversation.id),
          )
          .order('desc')
          .take(12)
      : [];
    const { eventId, turnId, deadline } = pendingTurn;
    const local = await identity(ctx);
    const bindings = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', worldId))
      .collect();
    const participants = descriptions
      .filter(
        (d) => !conversation || conversation.participants.some((m) => m.playerId === d.playerId),
      )
      .map((d) => ({
        playerId: d.playerId,
        name: d.name,
        agentGlobalId:
          world.players.find((p) => p.id === d.playerId)?.remoteVisitor?.agentGlobalId ??
          bindings.find((b) => b.playerId === d.playerId)?.agentGlobalId ??
          `${local!.townId}/human:${worldId}:${d.playerId}`,
        homeTownId: d.originTownId ?? local!.townId,
      }));
    const observation = {
      eventId,
      turnId,
      deadline,
      federationConversationId: conversation
        ? `${local!.townId}/${worldId}/${conversation.id}`
        : undefined,
      position: player.position,
      conversation: conversation
        ? {
            id: conversation.id,
            status: conversation.participants.find((m) => m.playerId === player.id)?.status.kind,
            numMessages: conversation.numMessages,
            messages: messages.reverse().map((m) => ({
              messageId: m.messageUuid,
              text: m.text,
              author: m.author,
              occurredAt: m._creationTime,
            })),
          }
        : null,
      nearby: world.players
        .filter((p) => p.id !== player.id)
        .map((p) => ({
          playerId: p.id,
          name: descriptions.find((d) => d.playerId === p.id)?.name,
          position: p.position,
          available: !world.conversations.some((c) =>
            c.participants.some((m) => m.playerId === p.id),
          ),
        }))
        .slice(0, 20),
      participants,
      observedAt: now,
    };
    await ctx.db.insert('federationTurns', {
      visitId: visitor.visitId,
      eventId,
      turnId,
      worldId,
      playerId: player.id,
      conversationId: conversation?.id,
      federationConversationId: observation.federationConversationId,
      deadline,
      expectedNumMessages: conversation?.numMessages,
      state: 'PENDING',
    });
    pendingCount++;
    await enqueueMessage(ctx, {
      peerTownId: ledger.homeTownId,
      type: 'OBSERVATION',
      visitId: ledger.visitId,
      payload: observation,
    });
  }
}

export async function dispatchRuntimeMessage(ctx: MutationCtx, message: FederationMessage) {
  const ledger = await visit(ctx, message.visitId!);
  if (!ledger) throw new Error('VISIT_NOT_FOUND');
  // Final committed history has no authority to create a body or execute actions.
  // Its immutable visit/deployment fences were checked by transport, including
  // when delivery catches up after the resident has safely returned Home.
  if (message.type === 'CONVERSATION_ENDED') {
    if (ledger.role !== 'home') throw new Error('INVALID_HISTORY_RECIPIENT');
    return receiveConversationEnded(ctx, ledger, message.payload);
  }
  if (ledger.state !== 'ACTIVE' || ledger.leaseExpiry <= Date.now())
    throw new Error('VISIT_NOT_ACTIVE');
  const payload = message.payload;
  if (message.type === 'OBSERVATION') {
    if (
      ledger.role !== 'home' ||
      typeof payload.eventId !== 'string' ||
      typeof payload.turnId !== 'string' ||
      !Number.isFinite(payload.deadline) ||
      payload.deadline <= Date.now() ||
      payload.deadline > Date.now() + MAX_REPLY_TIMEOUT_MS ||
      payload.deadline > ledger.leaseExpiry
    )
      throw new Error('INVALID_OBSERVATION');
    const existing = await ctx.db
      .query('federationDecisionJobs')
      .withIndex('event', (q) => q.eq('eventId', payload.eventId))
      .unique();
    if (existing) return;
    const limits = await configuredResourceLimits(ctx.db);
    if (await pendingDecisionCount(ctx.db) >= limits.maxPendingDecisions) throw new Error('DECISION_QUEUE_FULL');
    if (
      payload.conversation &&
      payload.federationConversationId &&
      ledger.worldId &&
      ledger.homePlayerId
    ) {
      await recordConfirmedObservation(ctx, {
        worldId: ledger.worldId,
        playerId: ledger.homePlayerId,
        agentGlobalId: ledger.agentGlobalId,
        visitId: ledger.visitId,
        hostTownId: ledger.hostTownId,
        observationEventId: payload.eventId,
        federationConversationId: payload.federationConversationId,
        observedAt: payload.observedAt,
        messages: payload.conversation.messages,
        participants: payload.participants,
      });
    }
    const jobId = await ctx.db.insert('federationDecisionJobs', {
      visitId: ledger.visitId,
      eventId: payload.eventId,
      observation: payload,
      deadline: payload.deadline,
      state: 'PENDING',
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, actionRef('decision/run'), { jobId });
  } else if (message.type === 'DECISION') {
    if (ledger.role !== 'host' || !ledger.worldId || !ledger.hostPlayerId)
      throw new Error('INVALID_HOST_DECISION');
    const existing = await ctx.db
      .query('federationPendingActions')
      .withIndex('action', (q) => q.eq('actionId', payload.actionId))
      .unique();
    if (existing) return;
    const archivedFact = await ctx.db.query('federationActionFacts').withIndex('action', q => q.eq('actionId', payload.actionId)).unique();
    if (archivedFact) return;
    const turn = await ctx.db
      .query('federationTurns')
      .withIndex('turn', (q) => q.eq('turnId', payload.turnId))
      .unique();
    if (
      !turn ||
      turn.visitId !== ledger.visitId ||
      turn.eventId !== payload.basedOnEventId ||
      turn.state !== 'PENDING' ||
      turn.deadline <= Date.now()
    ) {
      await enqueueMessage(ctx, {
        peerTownId: ledger.homeTownId,
        type: 'ACTION_RESULT',
        visitId: ledger.visitId,
        payload: {
          actionId: payload.actionId,
          eventId: crypto.randomUUID(),
          accepted: false,
          error: 'STALE_TURN',
        },
      });
      return;
    }
    const inputId = await insertInput(ctx, ledger.worldId, 'federationAction', {
      playerId: parseGameId('players', ledger.hostPlayerId),
      visitId: ledger.visitId,
      actionId: payload.actionId,
      turnId: payload.turnId,
      agentAuthorityEpoch: ledger.agentAuthorityEpoch,
      visitLeaseVersion: ledger.visitLeaseVersion,
      deadline: turn.deadline,
      conversationId: turn.conversationId,
      expectedNumMessages: turn.expectedNumMessages,
      action: payload.action,
    });
    await ctx.db.insert('federationPendingActions', {
      actionId: payload.actionId,
      visitId: ledger.visitId,
      turnId: payload.turnId,
      basedOnEventId: payload.basedOnEventId,
      agentAuthorityEpoch: ledger.agentAuthorityEpoch,
      visitLeaseVersion: ledger.visitLeaseVersion,
      action: payload.action,
      inputId,
      state: 'PENDING',
      createdAt: Date.now(),
    });
    await ctx.db.patch(turn._id, { state: 'ACCEPTED' });
  } else if (message.type === 'ACTION_RESULT') {
    if (ledger.role !== 'home' || !ledger.worldId || !ledger.homePlayerId)
      throw new Error('INVALID_HOME_RESULT');
    if (payload.accepted && payload.description && Array.isArray(payload.participants)) {
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('agent/travelMemory:recordConfirmedEvent'),
        {
          worldId: ledger.worldId,
          playerId: ledger.homePlayerId,
          agentGlobalId: ledger.agentGlobalId,
          visitId: ledger.visitId,
          eventId: payload.eventId,
          hostTownId: ledger.hostTownId,
          description: payload.description,
          participants: payload.participants.map(
            (p: { agentGlobalId: string; name: string; homeTownId: string }) => ({
              agentGlobalId: p.agentGlobalId,
              name: p.name,
              homeTownId: p.homeTownId,
            }),
          ),
          occurredAt: payload.occurredAt,
        },
      );
    }
  }
}

export async function commitRemoteActions(ctx: MutationCtx) {
  const jobs = await ctx.db
    .query('federationPendingActions')
    .withIndex('state', (q) => q.eq('state', 'PENDING'))
    .take(100);
  for (const job of jobs) {
    const input = await ctx.db.get(job.inputId);
    if (!input?.returnValue) continue;
    const ledger = await visit(ctx, job.visitId);
    if (!ledger) throw new Error('VISIT_NOT_FOUND');
    const turn = await ctx.db
      .query('federationTurns')
      .withIndex('turn', (q) => q.eq('turnId', job.turnId))
      .unique();
    const result = input.returnValue;
    const accepted = result.kind === 'ok';
    if (
      accepted &&
      (ledger.state !== 'ACTIVE' ||
        ledger.leaseExpiry <= Date.now() ||
        ledger.agentAuthorityEpoch !== job.agentAuthorityEpoch ||
        ledger.visitLeaseVersion !== job.visitLeaseVersion)
    ) {
      // Abort the whole engine commit: neither its state nor its messages may escape fencing.
      throw new Error('STALE_FEDERATION_ENGINE_COMMIT');
    }
    let description = '';
    if (
      accepted &&
      job.action.type === 'say' &&
      turn?.conversationId &&
      ledger.worldId &&
      ledger.hostPlayerId
    ) {
      await ctx.db.insert('messages', {
        worldId: ledger.worldId,
        conversationId: turn.conversationId,
        messageUuid: job.actionId,
        author: ledger.hostPlayerId,
        text: job.action.text,
      });
      description = `At ${ledger.hostTownId}, I said: ${job.action.text}`;
    } else if (accepted) description = `At ${ledger.hostTownId}, completed ${job.action.type}.`;
    const observed = await ctx.db
      .query('federationOutbox')
      .filter((q) => q.eq(q.field('envelope.payload.eventId'), job.basedOnEventId))
      .first();
    // Persist the receipt fact with the engine side effects even when the
    // network notification cannot enter the bounded transport queue yet.
    const receiptPayload = {
      actionId: job.actionId,
      eventId: job.actionId,
      accepted,
      description,
      participants: observed?.envelope.payload.participants ?? [],
      occurredAt: Date.now(),
      ...(result.kind === 'error' ? { error: result.message } : {}),
    };
    await ctx.db.patch(job._id, {
      state: accepted ? 'COMMITTED' : 'REJECTED',
      result,
      receiptPending: true,
      receiptPayload,
      receiptRetryAt: Date.now(),
    });
    await tryQueueReceipt(ctx, { ...job, receiptPayload });
    if (turn) await ctx.db.patch(turn._id, { state: accepted ? 'COMMITTED' : 'REJECTED' });
    if (accepted && job.action.type === 'leaveTown') await hostRemoved(ctx, job.visitId);
  }
}
async function tryQueueReceipt(ctx: MutationCtx, job: Doc<'federationPendingActions'>) {
  if (!job.receiptPayload) return;
  const ledger = await visit(ctx, job.visitId),
    local = await identity(ctx);
  if (
    !ledger ||
    ledger.role !== 'host' ||
    ledger.state !== 'ACTIVE' ||
    ledger.leaseExpiry <= Date.now() ||
    ledger.agentAuthorityEpoch !== job.agentAuthorityEpoch ||
    ledger.visitLeaseVersion !== job.visitLeaseVersion ||
    !local ||
    local.mode !== 'ACTIVE' ||
    local.deploymentEpoch !== ledger.hostDeploymentEpoch
  ) {
    // Keep the committed fact, but stop notification retries when its original
    // execution authority ends. Never wrap an old fact in a newer lease.
    await ctx.db.patch(job._id, { receiptPending: false, receiptRetryAt: undefined });
    return;
  }
  const remote = await peer(ctx, ledger.homeTownId);
  const outbox = await ctx.db
    .query('federationOutbox')
    .withIndex('retry', (q) => q.eq('ackedAt', undefined).eq('failedAt', undefined))
    .take(900);
  if (
    remote?.trustState !== 'TRUSTED' ||
    remote.deploymentEpoch !== ledger.homeDeploymentEpoch ||
    outbox.length >= 900
  ) {
    // Back off blocked receipts so disconnected peers cannot monopolize every
    // bounded recovery batch and starve receipts for reachable peers.
    await ctx.db.patch(job._id, { receiptRetryAt: Date.now() + 10000 });
    return;
  }
  await enqueueMessage(ctx, {
    peerTownId: ledger.homeTownId,
    type: 'ACTION_RESULT',
    visitId: ledger.visitId,
    payload: job.receiptPayload,
  });
  await ctx.db.patch(job._id, { receiptPending: false, receiptRetryAt: undefined });
}
export async function flushRemoteReceipts(ctx: MutationCtx) {
  const pending = await ctx.db
    .query('federationPendingActions')
    .withIndex('receiptPending', (q) =>
      q.eq('receiptPending', true).lte('receiptRetryAt', Date.now()),
    )
    .take(50);
  for (const job of pending) await tryQueueReceipt(ctx, job);
}

export const reconcileEngineJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    await commitPresenceJobs(ctx);
    await commitRemoteActions(ctx);
    await flushRemoteReceipts(ctx);
  },
});
