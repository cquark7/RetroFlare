import { z } from "zod";
import { ActorIdSchema, ClientIdSchema, IsoDateTimeSchema, UuidSchema } from "../src/shared/domain";

export const SocketAttachmentSchema = z
  .object({
    actorId: ActorIdSchema,
    retroId: UuidSchema,
    clientId: ClientIdSchema,
    expiresAt: IsoDateTimeSchema,
    warningSent: z.boolean(),
    isAdministrator: z.boolean(),
    editingCardId: UuidSchema.optional(),
    editingUpdatedAt: IsoDateTimeSchema.optional(),
    lastPresenceCommandAt: IsoDateTimeSchema.optional()
  })
  .strict();

export type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;

export function deserializeSocketAttachment(socket: WebSocket): SocketAttachment | undefined {
  const value: unknown = socket.deserializeAttachment();
  const parsed = SocketAttachmentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function writeSocketAttachment(socket: WebSocket, attachment: SocketAttachment): void {
  socket.serializeAttachment(SocketAttachmentSchema.parse(attachment));
}
