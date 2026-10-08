import { z } from "zod";
import { LIMITS } from "./constants";
import {
  ActorIdSchema,
  BoardColumnIdSchema,
  CardSchema,
  ClosingStateSchema,
  ColumnIdSchema,
  ForcedFinishAuditSchema,
  IsoDateTimeSchema,
  ParticipantSchema,
  ReactionEmojiSchema,
  ReadyClientSchema,
  UuidSchema,
  CaptainRecoveryAuditSchema,
  CaptainTransferAuditSchema
} from "./domain";

const PersistedEventBase = {
  retroId: UuidSchema,
  revision: z.number().int().positive(),
  occurredAt: IsoDateTimeSchema
};

export const CardCreatedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("card.created"),
    card: CardSchema
  })
  .strict();

export const CardUpdatedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("card.updated"),
    cardId: UuidSchema,
    text: z.string().max(LIMITS.cardTextCharacters),
    actionOwnerName: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.actionOwnerNameCharacters)
      .nullable(),
    version: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export const CardDeletedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("card.deleted"),
    cardId: UuidSchema,
    deletedVersion: z.number().int().positive()
  })
  .strict();

export const CardMovedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("card.moved"),
    cardId: UuidSchema,
    fromColumnId: ColumnIdSchema,
    columnId: ColumnIdSchema,
    actionOwnerName: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.actionOwnerNameCharacters)
      .nullable(),
    version: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.columnId !== "actions" && event.actionOwnerName !== null) {
      context.addIssue({
        code: "custom",
        path: ["actionOwnerName"],
        message: "Only action cards can have an owner."
      });
    }
  });

export const CardReorderedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("card.reordered"),
    cardId: UuidSchema,
    columnId: BoardColumnIdSchema,
    orderedCardIds: z.array(UuidSchema).min(1).max(LIMITS.cardsPerRetro)
      .refine((ids) => new Set(ids).size === ids.length, "Card IDs must be unique.")
  })
  .strict();

export const ReactionChangedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("reaction.changed"),
    actorId: ActorIdSchema,
    cardId: UuidSchema,
    emoji: ReactionEmojiSchema,
    reacted: z.boolean(),
    reactionCount: z.number().int().nonnegative().max(LIMITS.participantsPerRetro)
  })
  .strict();

export const ParticipantUpsertedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("participant.upserted"),
    participant: ParticipantSchema
  })
  .strict();

export const CaptainTransferredEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("captain.transferred"),
    captainId: ActorIdSchema,
    audit: CaptainTransferAuditSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.captainId !== event.audit.newCaptainId) {
      context.addIssue({
        code: "custom",
        path: ["audit", "newCaptainId"],
        message: "Transfer audit and resulting captain must match."
      });
    }
  });

export const CaptainRecoveredEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("captain.recovered"),
    captainId: ActorIdSchema,
    audit: CaptainRecoveryAuditSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.captainId !== event.audit.recoveredCaptainId) {
      context.addIssue({
        code: "custom",
        path: ["audit", "recoveredCaptainId"],
        message: "Recovery audit and resulting captain must match."
      });
    }
  });

export const RetroClosingStartedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("retro.closing.started"),
    closing: ClosingStateSchema
  })
  .strict();

export const RetroClosingReadyEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("retro.closing.ready"),
    generation: UuidSchema,
    client: ReadyClientSchema,
    readyCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((event, context) => {
    if (event.readyCount > event.requiredCount) {
      context.addIssue({
        code: "custom",
        path: ["readyCount"],
        message: "Ready clients cannot exceed the captured client set."
      });
    }
  });

export const RetroClosingCancelledEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("retro.closing.cancelled"),
    generation: UuidSchema
  })
  .strict();

export const RetroClosingDeadlineReachedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("retro.closing.deadline-reached"),
    generation: UuidSchema,
    deadline: IsoDateTimeSchema
  })
  .strict();

export const RetroClosedEventSchema = z
  .object({
    ...PersistedEventBase,
    type: z.literal("retro.closed"),
    generation: UuidSchema,
    closedAt: IsoDateTimeSchema,
    forcedSavedContent: z.boolean(),
    removedEmptyCardIds: z.array(UuidSchema),
    audit: ForcedFinishAuditSchema.optional()
  })
  .strict()
  .superRefine((event, context) => {
    if (event.forcedSavedContent !== (event.audit !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["audit"],
        message: "Saved-content finishing must include its audit record."
      });
    }
    if (event.audit && event.audit.generation !== event.generation) {
      context.addIssue({
        code: "custom",
        path: ["audit", "generation"],
        message: "Forced-finish audit must reference the closing generation."
      });
    }
  });

export const PersistedBoardEventSchema = z.discriminatedUnion("type", [
  CardCreatedEventSchema,
  CardUpdatedEventSchema,
  CardDeletedEventSchema,
  CardMovedEventSchema,
  CardReorderedEventSchema,
  ReactionChangedEventSchema,
  ParticipantUpsertedEventSchema,
  CaptainTransferredEventSchema,
  CaptainRecoveredEventSchema,
  RetroClosingStartedEventSchema,
  RetroClosingReadyEventSchema,
  RetroClosingCancelledEventSchema,
  RetroClosingDeadlineReachedEventSchema,
  RetroClosedEventSchema
]);
export type PersistedBoardEvent = z.infer<typeof PersistedBoardEventSchema>;
export type RetroClosedEvent = z.infer<typeof RetroClosedEventSchema>;
