/* eslint-disable */
  /**
   * Generated `api` utility.
   *
   * THIS CODE IS AUTOMATICALLY GENERATED.
   *
   * To regenerate, run `npx convex dev`.
   * @module
   */

  import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
  import type * as agent_conversation from "../agent/conversation.js";
import type * as agent_embeddingsCache from "../agent/embeddingsCache.js";
import type * as agent_memory from "../agent/memory.js";
import type * as agent_schema from "../agent/schema.js";
import type * as agent_travelMemory from "../agent/travelMemory.js";
import type * as aiTown_agent from "../aiTown/agent.js";
import type * as aiTown_agentDescription from "../aiTown/agentDescription.js";
import type * as aiTown_agentInputs from "../aiTown/agentInputs.js";
import type * as aiTown_agentModel from "../aiTown/agentModel.js";
import type * as aiTown_agentOperations from "../aiTown/agentOperations.js";
import type * as aiTown_conversation from "../aiTown/conversation.js";
import type * as aiTown_conversationMembership from "../aiTown/conversationMembership.js";
import type * as aiTown_game from "../aiTown/game.js";
import type * as aiTown_ids from "../aiTown/ids.js";
import type * as aiTown_inputHandler from "../aiTown/inputHandler.js";
import type * as aiTown_inputs from "../aiTown/inputs.js";
import type * as aiTown_insertInput from "../aiTown/insertInput.js";
import type * as aiTown_location from "../aiTown/location.js";
import type * as aiTown_main from "../aiTown/main.js";
import type * as aiTown_movement from "../aiTown/movement.js";
import type * as aiTown_player from "../aiTown/player.js";
import type * as aiTown_playerDescription from "../aiTown/playerDescription.js";
import type * as aiTown_schema from "../aiTown/schema.js";
import type * as aiTown_world from "../aiTown/world.js";
import type * as aiTown_worldMap from "../aiTown/worldMap.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as engine_abstractGame from "../engine/abstractGame.js";
import type * as engine_historicalObject from "../engine/historicalObject.js";
import type * as engine_schema from "../engine/schema.js";
import type * as federation_admin from "../federation/admin.js";
import type * as federation_auth from "../federation/auth.js";
import type * as federation_backup from "../federation/backup.js";
import type * as federation_backupHelpers from "../federation/backupHelpers.js";
import type * as federation_backupLarge from "../federation/backupLarge.js";
import type * as federation_backupLargeHelpers from "../federation/backupLargeHelpers.js";
import type * as federation_backupLargeSchema from "../federation/backupLargeSchema.js";
import type * as federation_backupSchema from "../federation/backupSchema.js";
import type * as federation_decision from "../federation/decision.js";
import type * as federation_direct from "../federation/direct.js";
import type * as federation_engineInputs from "../federation/engineInputs.js";
import type * as federation_identityRecovery from "../federation/identityRecovery.js";
import type * as federation_identityRecoverySchema from "../federation/identityRecoverySchema.js";
import type * as federation_ledger from "../federation/ledger.js";
import type * as federation_maintenanceLock from "../federation/maintenanceLock.js";
import type * as federation_peers from "../federation/peers.js";
import type * as federation_presence from "../federation/presence.js";
import type * as federation_protocol from "../federation/protocol.js";
import type * as federation_publicInput from "../federation/publicInput.js";
import type * as federation_queue from "../federation/queue.js";
import type * as federation_refs from "../federation/refs.js";
import type * as federation_remoteTick from "../federation/remoteTick.js";
import type * as federation_replyPolicy from "../federation/replyPolicy.js";
import type * as federation_runtime from "../federation/runtime.js";
import type * as federation_runtimeSchema from "../federation/runtimeSchema.js";
import type * as federation_schema from "../federation/schema.js";
import type * as federation_security from "../federation/security.js";
import type * as federation_storagePolicy from "../federation/storagePolicy.js";
import type * as federation_storageSchema from "../federation/storageSchema.js";
import type * as federation_store from "../federation/store.js";
import type * as federation_transport from "../federation/transport.js";
import type * as http from "../http.js";
import type * as init from "../init.js";
import type * as maintenanceFunctions from "../maintenanceFunctions.js";
import type * as messages from "../messages.js";
import type * as models_compatibility from "../models/compatibility.js";
import type * as models_embeddings from "../models/embeddings.js";
import type * as models_profiles from "../models/profiles.js";
import type * as models_schema from "../models/schema.js";
import type * as music from "../music.js";
import type * as schema from "../schema.js";
import type * as testing from "../testing.js";
import type * as util_FastIntegerCompression from "../util/FastIntegerCompression.js";
import type * as util_assertNever from "../util/assertNever.js";
import type * as util_asyncMap from "../util/asyncMap.js";
import type * as util_compression from "../util/compression.js";
import type * as util_geometry from "../util/geometry.js";
import type * as util_isSimpleObject from "../util/isSimpleObject.js";
import type * as util_llm from "../util/llm.js";
import type * as util_minheap from "../util/minheap.js";
import type * as util_object from "../util/object.js";
import type * as util_sleep from "../util/sleep.js";
import type * as util_types from "../util/types.js";
import type * as util_xxhash from "../util/xxhash.js";
import type * as world from "../world.js";

  /**
   * A utility for referencing Convex functions in your app's API.
   *
   * Usage:
   * ```js
   * const myFunctionReference = api.myModule.myFunction;
   * ```
   */
  declare const fullApi: ApiFromModules<{
    "agent/conversation": typeof agent_conversation,
"agent/embeddingsCache": typeof agent_embeddingsCache,
"agent/memory": typeof agent_memory,
"agent/schema": typeof agent_schema,
"agent/travelMemory": typeof agent_travelMemory,
"aiTown/agent": typeof aiTown_agent,
"aiTown/agentDescription": typeof aiTown_agentDescription,
"aiTown/agentInputs": typeof aiTown_agentInputs,
"aiTown/agentModel": typeof aiTown_agentModel,
"aiTown/agentOperations": typeof aiTown_agentOperations,
"aiTown/conversation": typeof aiTown_conversation,
"aiTown/conversationMembership": typeof aiTown_conversationMembership,
"aiTown/game": typeof aiTown_game,
"aiTown/ids": typeof aiTown_ids,
"aiTown/inputHandler": typeof aiTown_inputHandler,
"aiTown/inputs": typeof aiTown_inputs,
"aiTown/insertInput": typeof aiTown_insertInput,
"aiTown/location": typeof aiTown_location,
"aiTown/main": typeof aiTown_main,
"aiTown/movement": typeof aiTown_movement,
"aiTown/player": typeof aiTown_player,
"aiTown/playerDescription": typeof aiTown_playerDescription,
"aiTown/schema": typeof aiTown_schema,
"aiTown/world": typeof aiTown_world,
"aiTown/worldMap": typeof aiTown_worldMap,
"constants": typeof constants,
"crons": typeof crons,
"engine/abstractGame": typeof engine_abstractGame,
"engine/historicalObject": typeof engine_historicalObject,
"engine/schema": typeof engine_schema,
"federation/admin": typeof federation_admin,
"federation/auth": typeof federation_auth,
"federation/backup": typeof federation_backup,
"federation/backupHelpers": typeof federation_backupHelpers,
"federation/backupLarge": typeof federation_backupLarge,
"federation/backupLargeHelpers": typeof federation_backupLargeHelpers,
"federation/backupLargeSchema": typeof federation_backupLargeSchema,
"federation/backupSchema": typeof federation_backupSchema,
"federation/decision": typeof federation_decision,
"federation/direct": typeof federation_direct,
"federation/engineInputs": typeof federation_engineInputs,
"federation/identityRecovery": typeof federation_identityRecovery,
"federation/identityRecoverySchema": typeof federation_identityRecoverySchema,
"federation/ledger": typeof federation_ledger,
"federation/maintenanceLock": typeof federation_maintenanceLock,
"federation/peers": typeof federation_peers,
"federation/presence": typeof federation_presence,
"federation/protocol": typeof federation_protocol,
"federation/publicInput": typeof federation_publicInput,
"federation/queue": typeof federation_queue,
"federation/refs": typeof federation_refs,
"federation/remoteTick": typeof federation_remoteTick,
"federation/replyPolicy": typeof federation_replyPolicy,
"federation/runtime": typeof federation_runtime,
"federation/runtimeSchema": typeof federation_runtimeSchema,
"federation/schema": typeof federation_schema,
"federation/security": typeof federation_security,
"federation/storagePolicy": typeof federation_storagePolicy,
"federation/storageSchema": typeof federation_storageSchema,
"federation/store": typeof federation_store,
"federation/transport": typeof federation_transport,
"http": typeof http,
"init": typeof init,
"maintenanceFunctions": typeof maintenanceFunctions,
"messages": typeof messages,
"models/compatibility": typeof models_compatibility,
"models/embeddings": typeof models_embeddings,
"models/profiles": typeof models_profiles,
"models/schema": typeof models_schema,
"music": typeof music,
"schema": typeof schema,
"testing": typeof testing,
"util/FastIntegerCompression": typeof util_FastIntegerCompression,
"util/assertNever": typeof util_assertNever,
"util/asyncMap": typeof util_asyncMap,
"util/compression": typeof util_compression,
"util/geometry": typeof util_geometry,
"util/isSimpleObject": typeof util_isSimpleObject,
"util/llm": typeof util_llm,
"util/minheap": typeof util_minheap,
"util/object": typeof util_object,
"util/sleep": typeof util_sleep,
"util/types": typeof util_types,
"util/xxhash": typeof util_xxhash,
"world": typeof world,
  }>;
  export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
  export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
