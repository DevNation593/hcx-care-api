/** Stored encrypted; everything outside the notes service works with the decrypted note. */
export const ENCRYPTED_NOTE_FIELDS = [
  'content',
  'diagnosis',
  'treatment',
  'observations',
  'deletionReason',
] as const;
