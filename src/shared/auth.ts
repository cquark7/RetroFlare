import { z } from "zod";
import { ActorIdSchema, IsoDateTimeSchema } from "./domain";

export const AuthPrincipalSchema = z
  .object({
    actorId: ActorIdSchema,
    subject: z.string().min(1).max(512),
    email: z.string().email().max(320),
    emailDomain: z.string().min(1).max(253),
    issuer: z.string().min(1).max(512),
    expiresAt: IsoDateTimeSchema,
    isAdministrator: z.boolean(),
    authMethod: z.enum(["cloudflare-access", "local-development"])
  })
  .strict();
export type AuthPrincipal = z.infer<typeof AuthPrincipalSchema>;

export const AuthConfigurationSchema = z
  .object({
    allowedEmailDomain: z.string().min(1).max(253),
    accessTeamIssuer: z.string().url(),
    accessAudience: z.string().min(1).max(512),
    appOrigin: z.string().url(),
    administratorEmails: z.array(z.string().email().max(320)).default([])
  })
  .strict();
export type AuthConfiguration = z.infer<typeof AuthConfigurationSchema>;
