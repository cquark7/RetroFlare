import { LIMITS } from "./constants";
import type { Retro } from "./domain";

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function serializedRetroByteLength(retro: Retro): number {
  return utf8ByteLength(JSON.stringify(retro));
}

export function fitsSerializedRetroLimit(retro: Retro): boolean {
  return serializedRetroByteLength(retro) <= LIMITS.serializedRetroBytes;
}
