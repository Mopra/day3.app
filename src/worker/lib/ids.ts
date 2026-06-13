const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdPrefix =
  | "acc"
  | "usr"
  | "dom"
  | "aud"
  | "sub"
  | "imp"
  | "cmp"
  | "rcp"
  | "evt"
  | "sup"
  | "rsk"
  | "job";

export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return `${prefix}_${out}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
