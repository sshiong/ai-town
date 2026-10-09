import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId, playerId } from './ids';

export const serializedPlayerDescription = {
  playerId,
  name: v.string(),
  description: v.string(),
  character: v.string(),
  originTownId: v.optional(v.string()),
  originTownName: v.optional(v.string()),
  visitId: v.optional(v.string()),
};
export type SerializedPlayerDescription = ObjectType<typeof serializedPlayerDescription>;

export class PlayerDescription {
  playerId: GameId<'players'>;
  name: string;
  description: string;
  character: string;
  originTownId?: string;
  originTownName?: string;
  visitId?: string;

  constructor(serialized: SerializedPlayerDescription) {
    const { playerId, name, description, character } = serialized;
    this.playerId = parseGameId('players', playerId);
    this.name = name;
    this.description = description;
    this.character = character;
    this.originTownId = serialized.originTownId;
    this.originTownName = serialized.originTownName;
    this.visitId = serialized.visitId;
  }

  serialize(): SerializedPlayerDescription {
    const { playerId, name, description, character } = this;
    return {
      playerId,
      name,
      description,
      character,
      originTownId: this.originTownId,
      originTownName: this.originTownName,
      visitId: this.visitId,
    };
  }
}
