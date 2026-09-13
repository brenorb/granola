const granola = window.granola;

const state = await granola.getState();
console.log(state.wallet);

const { book } = await granola.getOrderBook();
if (book.topAsk) {
  const trade = await granola.takeOrder({
    requestId: crypto.randomUUID(),
    address: book.topAsk.address,
    expectedProjectionId: book.topAsk.eventId,
    expectedRevision: book.topAsk.state.revision,
    fillBaseAmount: book.topAsk.state.remaining_amount
  });
  console.log(await granola.runUntilSettled(trade.sessionId));
}
