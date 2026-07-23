import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

import { createInboxList, probeInboxRelayLive } from "../src/nostr/inbox.js";
import { NostrToolsInboxRelayPort } from "../src/nostr/inbox-relay.js";

const relay = "wss://auth.nostr1.com";
const now = Math.floor(Date.now() / 1000);
const recipientKey = generateSecretKey();
const senderKey = generateSecretKey();
const otherKey = generateSecretKey();
const wrapperKey = generateSecretKey();
const recipient = getPublicKey(recipientKey);
const inboxList = createInboxList([relay], recipientKey, now);
const wrapper = finalizeEvent({
  kind: 1059,
  created_at: now - 30,
  tags: [["p", recipient], ["expiration", String(now + 3_600)]],
  content: "granola encrypted inbox capability probe"
}, wrapperKey);

const result = await probeInboxRelayLive({
  relay,
  inboxList,
  wrapper,
  recipientProtocolSecretKey: recipientKey,
  senderProtocolSecretKey: senderKey,
  otherProtocolSecretKey: otherKey,
  port: new NostrToolsInboxRelayPort(),
  now
});

console.log(JSON.stringify({
  ...result,
  inboxListEventId: inboxList.id,
  giftWrapEventId: wrapper.id,
  recipientPubkey: recipient
}, null, 2));
