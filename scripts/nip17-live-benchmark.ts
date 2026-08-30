import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey
} from "nostr-tools/pure";

import {
  createInboxList,
  probeInboxRelayLive
} from "../src/nostr/inbox.js";
import { NostrToolsInboxRelayPort } from "../src/nostr/inbox-relay.js";
import { PUBLIC_RELAYS } from "../src/nostr/relay.js";
import { NostrTradeTransport } from "../src/nostr/trade-transport.js";

const inboxRelay = "wss://auth.nostr1.com";
const publish = ((globalThis as {
  process?: { argv?: string[] };
}).process?.argv ?? []).includes("--publish");

if (!publish) {
  console.log(JSON.stringify({
    benchmark: "granola-nip17-live",
    mode: "dry-run",
    publishes: ["kind 10050 inbox list", "kind 1059 disposable gift wrap"],
    discoveryRelays: PUBLIC_RELAYS,
    inboxRelay,
    run: "npm run benchmark:nip17-live -- --publish"
  }, null, 2));
} else {
  await runLiveBenchmark();
}

async function runLiveBenchmark(): Promise<void> {
  const recipientKey = generateSecretKey();
  const senderKey = generateSecretKey();
  const probeOtherKey = generateSecretKey();
  const wrapperKey = generateSecretKey();

  try {
    const now = Math.floor(Date.now() / 1_000);
    const recipient = getPublicKey(recipientKey);
    const sender = getPublicKey(senderKey);
    const wrapperSigner = getPublicKey(wrapperKey);
    const port = new NostrToolsInboxRelayPort();
    const inboxList = createInboxList([inboxRelay], recipientKey, now);
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: now - 30,
      tags: [["p", recipient], ["expiration", String(now + 3_600)]],
      content: "granola-nip17-live-benchmark"
    }, wrapperKey);

    const probe = await timed(() => probeInboxRelayLive({
      relay: inboxRelay,
      inboxList,
      wrapper,
      recipientProtocolSecretKey: recipientKey,
      senderProtocolSecretKey: senderKey,
      otherProtocolSecretKey: probeOtherKey,
      port,
      now
    }));
    const transport = new NostrTradeTransport(
      port,
      PUBLIC_RELAYS,
      [inboxRelay],
      () => Math.floor(Date.now() / 1_000),
      [probe.value]
    );
    const registration = transport.createRegistration(recipientKey);
    const publication = await timed(() =>
      transport.publishRegistration(registration, recipientKey)
    );
    const discovery = await timed(() =>
      transport.discoverInbox(recipient, senderKey)
    );
    const send = await timed(() =>
      transport.send(wrapper, discovery.value.relays, senderKey)
    );
    const read = await timed(() =>
      transport.read(recipient, recipientKey, now - 60)
    );

    console.log(JSON.stringify({
      benchmark: "granola-nip17-live",
      mode: "published-disposable-test-events",
      relays: { discovery: PUBLIC_RELAYS, inbox: [inboxRelay] },
      signerPubkeys: { recipient, sender, wrapper: wrapperSigner },
      eventIds: { inboxList: registration.id, giftWrap: wrapper.id },
      durationMs: {
        capabilityProbe: probe.durationMs,
        registration: publication.durationMs,
        discovery: discovery.durationMs,
        send: send.durationMs,
        read: read.durationMs,
        measuredPath: Number((
          publication.durationMs +
          discovery.durationMs +
          send.durationMs +
          read.durationMs
        ).toFixed(2))
      },
      acknowledgements: {
        registration: publication.value.receipts.map(({ relay, ok }) => ({ relay, ok })),
        registrationConfirmed: publication.value.confirmed,
        giftWrap: send.value.map(({ relay, ok }) => ({ relay, ok })),
        giftWrapReadBack: read.value.some(({ id }) => id === wrapper.id)
      }
    }, null, 2));
  } finally {
    recipientKey.fill(0);
    senderKey.fill(0);
    probeOtherKey.fill(0);
    wrapperKey.fill(0);
  }
}

async function timed<T>(action: () => Promise<T>): Promise<{
  value: T;
  durationMs: number;
}> {
  const startedAt = performance.now();
  const value = await action();
  return {
    value,
    durationMs: Number((performance.now() - startedAt).toFixed(2))
  };
}
