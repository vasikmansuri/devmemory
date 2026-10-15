import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

function encode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** Time-sortable, collision-resistant id: 9 chars of millisecond time + 16 random chars. */
export function newId(prefix: 'mem' | 'prj'): string {
  const time = Date.now().toString(32).padStart(9, '0');
  return `${prefix}_${time}${encode(randomBytes(16))}`;
}
