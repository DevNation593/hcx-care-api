/**
 * Whether the session of a token ended: it was issued under an earlier session version of the
 * account, which enabling or resetting the second factor bumps. The version is the one read when
 * the sign-in or refresh started, so a token signed after the bump from an earlier read is still
 * refused. Tokens without `sv` predate it and count as version 0.
 */
export function sessionEnded(
  payload: { sv?: number },
  user: { sessionVersion?: number | null },
): boolean {
  return (payload.sv ?? 0) !== (user.sessionVersion ?? 0);
}

/** Ends every session of the account: the update that enables or resets its second factor. */
export const nextSessionVersion = { sessionVersion: { increment: 1 } } as const;
