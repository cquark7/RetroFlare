import { z } from "zod";
import {
  BOARD_COLUMN_IDS,
  COLUMN_IDS,
  REACTION_EMOJIS,
  LIMITS,
  RETRO_SCHEMA_VERSION,
  RETRO_STATUSES
} from "./constants";

export const UuidSchema = z.string().uuid();
export const ActorIdSchema = z.string().min(1).max(128);
export const ClientIdSchema = UuidSchema;
export const IsoDateTimeSchema = z.string().datetime();
export const ColumnIdSchema = z.enum(COLUMN_IDS);
export const BoardColumnIdSchema = z.enum(BOARD_COLUMN_IDS);
export const RetroStatusSchema = z.enum(RETRO_STATUSES);

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.displayNameCharacters);
export const RetroTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.retroTitleCharacters);
export const CardTextSchema = z.string().max(LIMITS.cardTextCharacters);
export const ActionOwnerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.actionOwnerNameCharacters);

export const ParticipantSchema = z
  .object({
    actorId: ActorIdSchema,
    displayName: DisplayNameSchema,
    joinedAt: IsoDateTimeSchema
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const CardSchema = z
  .object({
    id: UuidSchema,
    columnId: ColumnIdSchema,
    sortOrder: z.number().int().nonnegative().optional(),
    text: CardTextSchema,
    authorId: ActorIdSchema,
    authorDisplayName: DisplayNameSchema,
    actionOwnerName: ActionOwnerNameSchema.optional(),
    version: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((card, context) => {
    if (card.actionOwnerName !== undefined && card.columnId !== "actions") {
      context.addIssue({
        code: "custom",
        path: ["actionOwnerName"],
        message: "Only action cards can have an owner."
      });
    }
    if (card.sortOrder !== undefined && card.columnId === "actions") {
      context.addIssue({
        code: "custom",
        path: ["sortOrder"],
        message: "Only reflection cards have a sortable position."
      });
    }
  });
export type Card = z.infer<typeof CardSchema>;

export const ClosingClientSchema = z
  .object({
    clientId: ClientIdSchema,
    actorId: ActorIdSchema
  })
  .strict();
export type ClosingClient = z.infer<typeof ClosingClientSchema>;

export const ReadyClientSchema = ClosingClientSchema.extend({
  readyAt: IsoDateTimeSchema
}).strict();
export type ReadyClient = z.infer<typeof ReadyClientSchema>;

export const ClosingStateSchema = z
  .object({
    generation: UuidSchema,
    requestedBy: ActorIdSchema,
    requestedAt: IsoDateTimeSchema,
    deadline: IsoDateTimeSchema,
    deadlineReached: z.boolean(),
    requiredClients: z.array(ClosingClientSchema).max(LIMITS.socketsPerDeployment),
    readyClients: z.array(ReadyClientSchema)
  })
  .strict()
  .superRefine((closing, context) => {
    const requiredByClient = new Map<string, string>();
    for (const [index, client] of closing.requiredClients.entries()) {
      if (requiredByClient.has(client.clientId)) {
        context.addIssue({
          code: "custom",
          path: ["requiredClients", index, "clientId"],
          message: "A client can only be captured once."
        });
      }
      requiredByClient.set(client.clientId, client.actorId);
    }

    const readyIds = new Set<string>();
    for (const [index, client] of closing.readyClients.entries()) {
      if (readyIds.has(client.clientId)) {
        context.addIssue({
          code: "custom",
          path: ["readyClients", index, "clientId"],
          message: "A client can only be marked ready once."
        });
      }
      readyIds.add(client.clientId);

      if (requiredByClient.get(client.clientId) !== client.actorId) {
        context.addIssue({
          code: "custom",
          path: ["readyClients", index],
          message: "Ready clients must match a captured client and verified actor."
        });
      }
    }
  });
export type ClosingState = z.infer<typeof ClosingStateSchema>;

export const CaptainTransferAuditSchema = z
  .object({
    type: z.literal("captain.transferred"),
    occurredAt: IsoDateTimeSchema,
    actorId: ActorIdSchema,
    previousCaptainId: ActorIdSchema,
    newCaptainId: ActorIdSchema
  })
  .strict();

export const CaptainRecoveryAuditSchema = z
  .object({
    type: z.literal("captain.recovered"),
    occurredAt: IsoDateTimeSchema,
    administratorId: ActorIdSchema,
    previousCaptainId: ActorIdSchema,
    recoveredCaptainId: ActorIdSchema,
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const ForcedFinishAuditSchema = z
  .object({
    type: z.literal("retro.force-finished"),
    occurredAt: IsoDateTimeSchema,
    actorId: ActorIdSchema,
    generation: UuidSchema,
    missingClientIds: z.array(ClientIdSchema)
  })
  .strict();

export const LifecycleAuditEntrySchema = z.discriminatedUnion("type", [
  CaptainTransferAuditSchema,
  CaptainRecoveryAuditSchema,
  ForcedFinishAuditSchema
]);
export type LifecycleAuditEntry = z.infer<typeof LifecycleAuditEntrySchema>;

export const ImportMetadataSchema = z
  .object({
    importedAt: IsoDateTimeSchema,
    importedFromStatus: RetroStatusSchema
  })
  .strict();
export type ImportMetadata = z.infer<typeof ImportMetadataSchema>;

const ParticipantMapSchema = z
  .record(ActorIdSchema, ParticipantSchema)
  .refine(
    (participants) => Object.keys(participants).length <= LIMITS.participantsPerRetro,
    `A retro can have at most ${LIMITS.participantsPerRetro} participants.`
  );

const CardMapSchema = z
  .record(UuidSchema, CardSchema)
  .refine(
    (cards) => Object.keys(cards).length <= LIMITS.cardsPerRetro,
    `A retro can have at most ${LIMITS.cardsPerRetro} cards.`
  );

export const ReactionEmojiSchema = z.enum(REACTION_EMOJIS);
export const CardReactionSchema = z.object({ cardId: UuidSchema, emoji: ReactionEmojiSchema }).strict();
const ReactionListSchema = z.array(CardReactionSchema)
  .max(LIMITS.cardsPerRetro * REACTION_EMOJIS.length)
  .refine((entries) => new Set(entries.map((entry) => `${entry.cardId}:${entry.emoji}`)).size === entries.length,
    "Each emoji can only be used once per card by a participant.");

export const RetroSchema = z
  .object({
    schemaVersion: z.literal(RETRO_SCHEMA_VERSION),
    id: UuidSchema,
    title: RetroTitleSchema,
    status: RetroStatusSchema,
    captainId: ActorIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.optional(),
    revision: z.number().int().nonnegative(),
    participants: ParticipantMapSchema,
    cards: CardMapSchema,
    reactions: z.record(ActorIdSchema, ReactionListSchema),
    closing: ClosingStateSchema.optional(),
    lifecycleAudit: z.array(LifecycleAuditEntrySchema),
    importMetadata: ImportMetadataSchema.optional()
  })
  .strict()
  .superRefine((retro, context) => {
    if (!retro.participants[retro.captainId]) {
      context.addIssue({
        code: "custom",
        path: ["captainId"],
        message: "The captain must be a joined participant."
      });
    }

    for (const [key, participant] of Object.entries(retro.participants)) {
      if (key !== participant.actorId) {
        context.addIssue({
          code: "custom",
          path: ["participants", key, "actorId"],
          message: "Participant map keys must match actor IDs."
        });
      }
    }

    for (const [key, card] of Object.entries(retro.cards)) {
      if (key !== card.id) {
        context.addIssue({
          code: "custom",
          path: ["cards", key, "id"],
          message: "Card map keys must match card IDs."
        });
      }
      if (!retro.participants[card.authorId]) {
        context.addIssue({
          code: "custom",
          path: ["cards", key, "authorId"],
          message: "A card author must be a joined participant."
        });
      }
    }

    for (const columnId of BOARD_COLUMN_IDS) {
      const columnCards = Object.values(retro.cards).filter((card) => card.columnId === columnId);
      const positionedCards = columnCards.filter((card) => card.sortOrder !== undefined);
      if (positionedCards.length > 0 && positionedCards.length !== columnCards.length) {
        context.addIssue({
          code: "custom",
          path: ["cards"],
          message: `Cards in ${columnId} must all have a position or all use chronological order.`
        });
      }
      if (new Set(positionedCards.map((card) => card.sortOrder)).size !== positionedCards.length) {
        context.addIssue({
          code: "custom",
          path: ["cards"],
          message: `Cards in ${columnId} cannot share a position.`
        });
      }
    }

    for (const [actorId, reactions] of Object.entries(retro.reactions)) {
      if (!retro.participants[actorId]) {
        context.addIssue({
          code: "custom",
          path: ["reactions", actorId],
          message: "Only joined participants can react."
        });
      }

      for (const [index, reaction] of reactions.entries()) {
        if (!retro.cards[reaction.cardId]) {
          context.addIssue({
            code: "custom",
            path: ["reactions", actorId, index],
            message: "Reactions must reference an existing card."
          });
        }
      }
    }

    if (retro.status === "closing" && !retro.closing) {
      context.addIssue({
        code: "custom",
        path: ["closing"],
        message: "A closing retro must include its closing generation."
      });
    }
    if (retro.status !== "closing" && retro.closing) {
      context.addIssue({
        code: "custom",
        path: ["closing"],
        message: "Only a closing retro can include closing state."
      });
    }
    if (retro.status === "closed" && !retro.closedAt) {
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A closed retro must include its close time."
      });
    }
    if (retro.status !== "closed" && retro.closedAt) {
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Only a closed retro can include a close time."
      });
    }
  });
export type Retro = z.infer<typeof RetroSchema>;

export const RetroSummarySchema = z
  .object({
    id: UuidSchema,
    title: RetroTitleSchema,
    status: RetroStatusSchema,
    captainId: ActorIdSchema,
    captainDisplayName: DisplayNameSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.optional(),
    cardCount: z.number().int().nonnegative().max(LIMITS.cardsPerRetro),
    participantCount: z.number().int().positive().max(LIMITS.participantsPerRetro),
    revision: z.number().int().nonnegative()
  })
  .strict();
export type RetroSummary = z.infer<typeof RetroSummarySchema>;

export function compareCardsChronologically(left: Card, right: Card): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  return byCreatedAt || left.id.localeCompare(right.id);
}

export function compareCardsInColumnOrder(left: Card, right: Card): number {
  if (left.columnId !== right.columnId) return left.columnId.localeCompare(right.columnId);
  if (left.sortOrder !== undefined && right.sortOrder !== undefined) {
    return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
  }
  if (left.sortOrder !== undefined) return -1;
  if (right.sortOrder !== undefined) return 1;
  return compareCardsChronologically(left, right);
}
