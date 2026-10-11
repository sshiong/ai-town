export type TravelPresence = { id: string; x: number; y: number; visitId?: string };
export type TravelEffect = { key: string; kind: 'arrival' | 'departure'; x: number; y: number; startedAt: number };
/** Snapshot changes are presentation only: no Presence, movement or identity writes. */
export function travelTransitions(previous: TravelPresence[] | undefined, current: TravelPresence[], away: Set<string>, previouslyAway: Set<string>, now: number): TravelEffect[] {
  if (!previous) return []; // The first snapshot establishes presence, not an arrival.
  const before = new Map(previous.map(player => [player.id, player]));
  const after = new Map(current.map(player => [player.id, player]));
  const effects: TravelEffect[] = [];
  for (const player of current) {
    const prior = before.get(player.id);
    if ((!prior && (player.visitId || previouslyAway.has(player.id))) || (prior && player.visitId && prior.visitId !== player.visitId))
      effects.push({ key: `arrival:${player.id}:${player.visitId ?? now}`, kind: 'arrival', x: player.x, y: player.y, startedAt: now });
  }
  for (const player of previous) {
    if (!after.has(player.id) && (player.visitId || away.has(player.id)))
      effects.push({ key: `departure:${player.id}:${player.visitId ?? now}`, kind: 'departure', x: player.x, y: player.y, startedAt: now });
  }
  return effects;
}
