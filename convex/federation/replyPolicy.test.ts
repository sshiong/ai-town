import { webcrypto } from 'node:crypto';
import { replyTimeoutMs } from './replyPolicy';
import { tickRemoteVisitor } from './remoteTick';
import type { Game } from '../aiTown/game';
import type { Player } from '../aiTown/player';

beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);

test('Host can set a bounded model SLA while old visitors retain the original default', () => {
  expect(replyTimeoutMs()).toBe(25_000);
  expect(replyTimeoutMs(90_000)).toBe(90_000);
  for (const timeout of [0, 4999, 120001, NaN, Infinity, 10000.1])
    expect(() => replyTimeoutMs(timeout)).toThrow('INVALID_REPLY_TIMEOUT');
});
test('remote turns use Host SLA and cannot outlive the visitor lease', () => {
  const now = Date.now();
  const visitor = {
    leaseExpiry: now + 300_000,
    lastObservationAt: 0,
    replyTimeoutMs: 90_000,
    pendingTurn: undefined,
  } as Player['remoteVisitor'];
  const game = { world: { playerConversation: () => undefined } } as unknown as Game;
  const player = { id: 'p:2', remoteVisitor: visitor } as Player;
  tickRemoteVisitor(game, now, player);
  expect(visitor!.pendingTurn!.deadline).toBe(now + 90_000);
  visitor!.pendingTurn = undefined;
  visitor!.lastObservationAt = 0;
  visitor!.leaseExpiry = now + 10_000;
  tickRemoteVisitor(game, now, player);
  expect(visitor!.pendingTurn!.deadline).toBe(visitor!.leaseExpiry);
});
