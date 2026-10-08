import { z } from "zod";
import { LIMITS, PROTOCOL_VERSION } from "./constants";
import {
  ActionOwnerNameSchema,
  ActorIdSchema,
  BoardColumnIdSchema,
  CardTextSchema,
  ClosingStateSchema,
  ColumnIdSchema,
  DisplayNameSchema,
  IsoDateTimeSchema,
  RetroSchema,
  ReactionEmojiSchema,
  UuidSchema
} from "./domain";
import { ApiErrorSchema } from "./errors";
import { PersistedBoardEventSchema, RetroClosedEventSchema } from "./events";

const ExpectedCardVersionSchema = z.number().int().positive();
const ExpectedRetroRevisionSchema = z.number().int().nonnegative();

function isGiphyMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && /^media\d*\.giphy\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export const GiphyMediaSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    imageUrl: z.string().url().max(LIMITS.giphyMediaUrlCharacters).refine(isGiphyMediaUrl, {
      message: "GIPHY media must use an HTTPS media.giphy.com URL."
    }),
    title: z.string().trim().min(1).max(LIMITS.giphyTitleCharacters)
  })
  .strict();
export type GiphyMedia = z.infer<typeof GiphyMediaSchema>;

export const CardCreateCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("card.create"),
    payload: z
      .object({
        cardId: UuidSchema,
        columnId: ColumnIdSchema,
        text: CardTextSchema,
        actionOwnerName: ActionOwnerNameSchema.optional()
      })
      .strict()
      .superRefine((payload, context) => {
        if (payload.actionOwnerName !== undefined && payload.columnId !== "actions") {
          context.addIssue({
            code: "custom",
            path: ["actionOwnerName"],
            message: "Only action cards can have an owner."
          });
        }
      })
  })
  .strict();

export const CardUpdateCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("card.update"),
    payload: z
      .object({
        cardId: UuidSchema,
        text: CardTextSchema,
        actionOwnerName: ActionOwnerNameSchema.nullable().optional(),
        expectedCardVersion: ExpectedCardVersionSchema
      })
      .strict()
  })
  .strict();

export const CardDeleteCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("card.delete"),
    payload: z
      .object({
        cardId: UuidSchema,
        expectedCardVersion: ExpectedCardVersionSchema
      })
      .strict()
  })
  .strict();

export const CardMoveCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("card.move"),
    payload: z
      .object({
        cardId: UuidSchema,
        columnId: ColumnIdSchema,
        expectedCardVersion: ExpectedCardVersionSchema
      })
      .strict()
  })
  .strict();

export const CardReorderCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("card.reorder"),
    payload: z
      .object({
        cardId: UuidSchema,
        columnId: BoardColumnIdSchema,
        orderedCardIds: z.array(UuidSchema).min(1).max(LIMITS.cardsPerRetro)
          .refine((ids) => new Set(ids).size === ids.length, "Card IDs must be unique."),
        expectedRetroRevision: ExpectedRetroRevisionSchema
      })
      .strict()
  })
  .strict();

export const ReactionSetCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("reaction.set"),
    payload: z
      .object({
        cardId: UuidSchema,
        emoji: ReactionEmojiSchema,
        reacted: z.boolean()
      })
      .strict()
  })
  .strict();

export const CaptainTransferCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("captain.transfer"),
    payload: z
      .object({
        nextCaptainId: ActorIdSchema,
        expectedRetroRevision: ExpectedRetroRevisionSchema
      })
      .strict()
  })
  .strict();

export const CaptainRecoverCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("captain.recover"),
    payload: z
      .object({
        newCaptainId: ActorIdSchema,
        expectedRetroRevision: ExpectedRetroRevisionSchema,
        reason: z.string().trim().min(1).max(500).optional()
      })
      .strict()
  })
  .strict();

export const RetroPrepareFinishCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("retro.prepareFinish"),
    payload: z.object({ expectedRetroRevision: ExpectedRetroRevisionSchema }).strict()
  })
  .strict();

export const RetroFinishReadyCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("retro.finishReady"),
    payload: z.object({ generation: UuidSchema }).strict()
  })
  .strict();

export const RetroFinalizeFinishCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("retro.finalizeFinish"),
    payload: z
      .object({
        generation: UuidSchema,
        forceSavedContent: z.boolean().optional(),
        confirmation: z.literal("finish-saved-content").optional()
      })
      .strict()
      .superRefine((payload, context) => {
        if (payload.forceSavedContent && payload.confirmation !== "finish-saved-content") {
          context.addIssue({
            code: "custom",
            path: ["confirmation"],
            message: "Finishing with saved content requires explicit confirmation."
          });
        }
        if (!payload.forceSavedContent && payload.confirmation !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["confirmation"],
            message: "Confirmation is only valid for saved-content finishing."
          });
        }
      })
  })
  .strict();

export const RetroCancelFinishCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("retro.cancelFinish"),
    payload: z.object({ generation: UuidSchema }).strict()
  })
  .strict();

export const PresenceEditingCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: UuidSchema,
    type: z.literal("presence.editing"),
    payload: z
      .object({
        cardId: UuidSchema,
        editing: z.boolean()
      })
      .strict()
  })
  .strict();

export const ClientCommandSchema = z.discriminatedUnion("type", [
  CardCreateCommandSchema,
  CardUpdateCommandSchema,
  CardDeleteCommandSchema,
  CardMoveCommandSchema,
  CardReorderCommandSchema,
  ReactionSetCommandSchema,
  CaptainTransferCommandSchema,
  CaptainRecoverCommandSchema,
  RetroPrepareFinishCommandSchema,
  RetroFinishReadyCommandSchema,
  RetroFinalizeFinishCommandSchema,
  RetroCancelFinishCommandSchema,
  PresenceEditingCommandSchema
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const CommandFrameSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commands: z.array(ClientCommandSchema).min(1).max(LIMITS.commandsPerFrame)
  })
  .strict();
export type CommandFrame = z.infer<typeof CommandFrameSchema>;

export const GiphyShareRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("giphy.share"),
    media: GiphyMediaSchema
  })
  .strict();
export type GiphyShareRequest = z.infer<typeof GiphyShareRequestSchema>;

export const ClientWebSocketFrameSchema = z.union([CommandFrameSchema, GiphyShareRequestSchema]);
export type ClientWebSocketFrame = z.infer<typeof ClientWebSocketFrameSchema>;

export const SnapshotMessageSchema = z
  .object({
    type: z.literal("snapshot"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retro: RetroSchema,
    serverTime: IsoDateTimeSchema,
    clientId: UuidSchema
  })
  .strict();

export const EventsMessageSchema = z
  .object({
    type: z.literal("events"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    events: z.array(PersistedBoardEventSchema).min(1)
  })
  .strict()
  .superRefine((message, context) => {
    let previousRevision = 0;
    for (const [index, event] of message.events.entries()) {
      if (event.retroId !== message.retroId) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "retroId"],
          message: "An event frame can only contain events for one retro."
        });
      }
      if (event.revision <= previousRevision) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "revision"],
          message: "Event revisions must be strictly increasing within a frame."
        });
      }
      previousRevision = event.revision;
    }
  });

export const AckMessageSchema = z
  .object({
    type: z.literal("ack"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    commandId: UuidSchema,
    resultingRevision: z.number().int().nonnegative(),
    outcome: z.enum(["applied", "noop"]),
    duplicate: z.boolean(),
    entity: z
      .object({
        kind: z.literal("card"),
        id: UuidSchema,
        version: z.number().int().positive()
      })
      .strict()
      .optional(),
    processedAt: IsoDateTimeSchema
  })
  .strict();

export const CommandErrorMessageSchema = z
  .object({
    type: z.literal("command.error"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    commandId: UuidSchema,
    error: ApiErrorSchema
  })
  .strict();

export const PresenceMessageSchema = z
  .object({
    type: z.literal("presence"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    clientId: UuidSchema,
    actorId: ActorIdSchema,
    displayName: DisplayNameSchema,
    connected: z.boolean(),
    cardId: UuidSchema.nullable(),
    editing: z.boolean(),
    updatedAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.editing !== (message.cardId !== null) || (message.editing && !message.connected)) {
      context.addIssue({
        code: "custom",
        path: ["cardId"],
        message: "Only a connected editor can have an active editing card."
      });
    }
  });

export const GiphySharedMessageSchema = z
  .object({
    type: z.literal("giphy.shared"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    shareId: UuidSchema,
    media: GiphyMediaSchema
  })
  .strict();
export type GiphySharedMessage = z.infer<typeof GiphySharedMessageSchema>;

export const FinishRequestedMessageSchema = z
  .object({
    type: z.literal("finish.requested"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    closing: ClosingStateSchema
  })
  .strict();

export const FinishProgressMessageSchema = z
  .object({
    type: z.literal("finish.progress"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    generation: UuidSchema,
    readyCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative(),
    missingClients: z.array(
      z.object({ clientId: UuidSchema, actorId: ActorIdSchema }).strict()
    )
  })
  .strict()
  .superRefine((message, context) => {
    if (message.readyCount + message.missingClients.length !== message.requiredCount) {
      context.addIssue({
        code: "custom",
        path: ["missingClients"],
        message: "Progress counts must match the captured client set."
      });
    }
  });

export const RetroClosedMessageSchema = z
  .object({
    type: z.literal("retro.closed"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    retroId: UuidSchema,
    event: RetroClosedEventSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.event.retroId !== message.retroId) {
      context.addIssue({
        code: "custom",
        path: ["event", "retroId"],
        message: "Close event and message must reference the same retro."
      });
    }
  });

export const AuthExpiringMessageSchema = z
  .object({
    type: z.literal("auth.expiring"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    expiresAt: IsoDateTimeSchema,
    warningAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.warningAt > message.expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["warningAt"],
        message: "The warning time must not be after session expiry."
      });
    }
  });

export const AuthRequiredMessageSchema = z
  .object({
    type: z.literal("auth.required"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    reason: z.enum(["expired", "revoked", "unauthenticated"])
  })
  .strict();

export const ResyncRequiredMessageSchema = z
  .object({
    type: z.literal("resync.required"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    reason: z.enum(["revision-gap", "server-restart", "state-unknown"]),
    currentRevision: z.number().int().nonnegative().optional()
  })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotMessageSchema,
  EventsMessageSchema,
  AckMessageSchema,
  CommandErrorMessageSchema,
  PresenceMessageSchema,
  FinishRequestedMessageSchema,
  FinishProgressMessageSchema,
  RetroClosedMessageSchema,
  GiphySharedMessageSchema,
  AuthExpiringMessageSchema,
  AuthRequiredMessageSchema,
  ResyncRequiredMessageSchema
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
