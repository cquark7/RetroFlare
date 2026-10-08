import { UuidSchema } from "./domain";

export function createOpaqueId(): string {
  return UuidSchema.parse(globalThis.crypto.randomUUID());
}
