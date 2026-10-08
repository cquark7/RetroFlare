export const COLUMN_IDS = ["went-well", "could-improve", "shoutouts", "actions"] as const;
export const BOARD_COLUMN_IDS = ["went-well", "could-improve", "shoutouts"] as const;
export const VOTABLE_COLUMN_IDS = ["went-well", "could-improve"] as const;
export const RETRO_STATUSES = ["open", "closing", "closed"] as const;

export const REACTION_EMOJIS = ["👍", "🎉", "❤️", "😂", "💡", "👀", "🙌", "🚀"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
export const PROTOCOL_VERSION = 5 as const;
export const STORAGE_SCHEMA_VERSION = 3 as const;
export const RETRO_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION;
export const BACKUP_EXPORT_VERSION = 4 as const;
export const BACKUP_FORMAT = "retroflare-backup" as const;
export const TEAM_OBJECT_NAME = "team-v1" as const;

export const LIMITS = {
  displayNameCharacters: 60,
  retroTitleCharacters: 120,
  cardTextCharacters: 2_000,
  actionOwnerNameCharacters: 60,
  cardsPerRetro: 150,
  participantsPerRetro: 50,
  votesPerParticipant: 3,
  serializedRetroBytes: 1_048_576,
  incomingWebSocketFrameBytes: 32 * 1_024,
  commandsPerFrame: 10,
  socketsPerActorPerRetro: 3,
  socketsPerDeployment: 100,
  completedHistoryPageSize: 25,
  bulkImportBytes: 10 * 1_024 * 1_024,
  importBatchBoards: 25,
  recentOperationsPerRetro: 1_024,
  actorMutationsPerMinute: 120,
  actorMutationBurst: 20,
  retroCreationsPerActorPerHour: 5,
  retroCreationsPerDeploymentPerDay: 20,
  authSessionMs: 4 * 60 * 60 * 1_000,
  socketMaximumLifetimeMs: 4 * 60 * 60 * 1_000,
  closingWindowMs: 15 * 1_000,
  editingPresenceLeaseMs: 10 * 1_000,
  editingPresenceRefreshMs: 5 * 1_000,
  giphyMediaUrlCharacters: 2_048,
  giphyTitleCharacters: 120,
  giphyShareLifetimeMs: 8 * 1_000,
  draftTrailingSaveMs: 3 * 1_000,
  draftMaximumWaitMs: 5 * 1_000,
  localDraftLifetimeMs: 24 * 60 * 60 * 1_000
} as const;

export type ColumnId = (typeof COLUMN_IDS)[number];
export type BoardColumnId = (typeof BOARD_COLUMN_IDS)[number];
export type VotableColumnId = (typeof VOTABLE_COLUMN_IDS)[number];
export type RetroStatus = (typeof RETRO_STATUSES)[number];

export function isVotableColumn(columnId: ColumnId): columnId is VotableColumnId {
  return (VOTABLE_COLUMN_IDS as readonly string[]).includes(columnId);
}

export function isBoardColumn(columnId: ColumnId): columnId is BoardColumnId {
  return (BOARD_COLUMN_IDS as readonly string[]).includes(columnId);
}
