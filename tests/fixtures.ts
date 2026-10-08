import { RETRO_SCHEMA_VERSION } from "../src/shared/constants";
import type { Retro } from "../src/shared/domain";

export const actorId = "actor:engineering-user-1";
export const retroId = "00000000-0000-4000-8000-000000000001";
export const cardId = "00000000-0000-4000-8000-000000000002";
export const clientId = "00000000-0000-4000-8000-000000000003";
export const generation = "00000000-0000-4000-8000-000000000004";
export const timestamp = "2026-10-07T12:00:00.000Z";

export function makeRetro(overrides: Partial<Retro> = {}): Retro {
  return {
    schemaVersion: RETRO_SCHEMA_VERSION,
    id: retroId,
    title: "October retrospective",
    status: "open",
    captainId: actorId,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    participants: {
      [actorId]: {
        actorId,
        displayName: "Avery",
        joinedAt: timestamp
      }
    },
    cards: {
      [cardId]: {
        id: cardId,
        columnId: "went-well",
        text: "Deploys were calm",
        authorId: actorId,
        authorDisplayName: "Avery",
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    reactions: {},
    lifecycleAudit: [],
    ...overrides
  };
}
