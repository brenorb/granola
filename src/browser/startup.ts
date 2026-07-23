export interface InboxStartupInput {
  startSessions: () => Promise<unknown>;
  startMaker: () => Promise<unknown>;
}

export async function startInboxListeners(
  input: InboxStartupInput
): Promise<void> {
  await Promise.all([
    input.startSessions(),
    input.startMaker()
  ]);
}
