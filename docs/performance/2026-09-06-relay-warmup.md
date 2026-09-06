# Relay connections prepared while browsing

## Change

Page startup already initializes the trade runtime while loading the order book and
existing sessions. The runtime now starts two unauthenticated WebSocket connections
to the private inbox relay and loads its public NIP-11 capabilities in the background.
After the initial inbox probe, it prepares two connections per public discovery relay.
This gives the public order-book connections a head start: opening all spare sockets
at once competed with subscription startup in the real browser validation.
The existing public order-book pool continues to reuse its own connections.

The inbox adapter consumes each prepared connection once, authenticates it with the
current operation's key, and closes it after the operation/subscription. A used socket
is never returned to the spare queue. No reservation keys or messages are created
by warmup. This retains identity isolation; unauthenticated does not mean IP-anonymous.

Consumed spares are replenished without awaiting them. Idle failed/closed spares are
checked every 30 seconds; configuration is bounded to five remote relays and two
spares each. The default configuration has four WSS endpoints (eight spares per
page). Pagehide disposes spares and timers, including late connection completions.
The optional localhost mesh is not preconnected.

A missing, failed or closed spare falls back to a fresh connection. An expired AUTH
challenge on a prepared socket retries once on a fresh connection before publication.
ACK, validated readback, per-reservation identities and all financial verification
requirements are unchanged. Mint proof subscriptions and their connections are not
part of this relay warmup.

## Validation

TypeScript and the full suite passed: 421 tests passed, 7 skipped. Regressions cover
no publication/AUTH during preparation, identity isolation, non-blocking refill,
late completion cleanup, disposal, bounded idle retry, stale sockets, cached optional
AUTH challenges and expired-challenge fallback. Performance diagnostics whitelist
only the acquisition outcome and timing, never AUTH data or keys.

## Measurement method

The real Testnut browser profile waits 20 seconds after both pages reload before
publishing each order. The taker remains open and receives the order before taking
it. The clock for the swap still starts at the take click and ends at the later
Filled mark; no measured time is subtracted to manufacture a handshake-free result.

`granola:relay-connect` measures how long an operation waits to acquire its transport
(warm, warming, cold or failed), before AUTH. CDP also records raw socket handshakes.
Background refill handshakes may occur during the trade without blocking it, so their
union must not be reported as delay added to the swap. AUTH and relay response waits
remain separate, necessary network operations. A stale connection can still require
a foreground reconnect; the measurements must disclose it if it happens.

## Resultado no site publicado

Código: `d1d7cb4` e `d036e9b`, asset `index-Db6e1jn6.js`, confirmado nas duas
carteiras. [Deploy e CI concluídos](https://github.com/brenorb/granola/actions/runs/34051159673).
A série abaixo usa três swaps reais de Testnut entre duas carteiras no Chrome,
pela interface, na sequência venda / compra / venda. Cada ordem tinha 20 SAT,
limite de 50.400 USD/BTC e liquidação de 1 centavo; o limite anterior de 50.000
produzia os mesmos valores de liquidação. As páginas ficaram abertas por 20 segundos
antes de cada publicação. Nenhum Refresh Swaps ou recuperação manual foi necessário.

| Medida | Venda 1 | Compra | Venda 2 |
| --- | ---: | ---: | ---: |
| Clique do taker até ambas Filled | 16,781 s | 18,426 s | 17,686 s |
| Publicação da ordem, medida separadamente | 1,423 s | 1,296 s | 1,202 s |
| Conexões entregues já prontas | 16 | 16 | 16 |
| Soma do tempo para entregar essas conexões | 8,8 ms | 8,2 ms | 8,4 ms |
| Maior espera por uma conexão já pronta | 2,5 ms | 2,2 ms | 2,3 ms |
| Reconexões frias bem-sucedidas | 1 (899 ms) | 0 | 0 |
| Tentativas de conexão que falharam | 10 | 10 | 11 |
| União temporal de todas as aquisições, incluindo falhas | 3,528 s | 3,459 s | 3,408 s |
| JavaScript estimado na carteira A / B | 0,656 / 0,547 s | 0,590 / 0,776 s | 0,967 / 0,897 s |
| União temporal das transações IndexedDB | 0,310 s | 0,481 s | 0,515 s |
| Metadata da mint / checks HTTP de proofs | 12 / 10 | 12 / 10 | 12 / 11 |
| Swaps na mint / verificações restore | 4 / 4 | 4 / 4 | 4 / 4 |
| Esperas WS de proofs: SPENT / indisponível | 4 / 0 | 3 / 1 | 2 / 3 |

A mediana caiu de **22,018 s para 17,686 s**, diferença de **4,333 s (19,7%)**
em relação à versão imediatamente anterior, que já reutilizava metadata, IndexedDB
e conexão de publicação/readback, além de antecipar descoberta de inbox.
São três amostras sequenciais com terceiros variáveis; não é garantia de ganho fixo.

### O que saiu da espera e o que ainda ficou

As 16 conexões prontas por swap passaram a custar poucos milissegundos para quem
as solicita. O handshake delas aconteceu antes, durante a navegação ou durante
outro trabalho independente. Não houve espera por um spare ainda em preparação
nesses três swaps.

**Ainda não é zero espera por conexão.** Houve falhas no `offchain.pub` e no mesh
opcional `ws://localhost:4870`, que não estava rodando. A correlação dos horários
de aquisição com os sockets CDP identifica as tentativas longas com offchain e as
falhas locais curtas com localhost. Uma conexão fria de offchain conseguiu abrir
em 899 ms na primeira amostra. Não foi estabelecida a causa remota das recusas.
Conexão preparada não garante que um terceiro a aceite ou mantenha aberta.

As tentativas pendentes/falhas ocuparam intervalos que, unidos, chegaram a cerca
de 3,4–3,5 s. Parte ocorre em paralelo com trabalho independente: **esse número
não deve ser subtraído integralmente do swap como ganho adicional disponível**.
Também não se deve chamar esse tempo de processamento local. As falhas de conexão
não dispensam quorum, validação de readback nem as verificações financeiras.

CDP ainda observou 4,275 / 5,027 / 5,158 s de união de handshakes de relay
durante os swaps, incluindo reposição de conexões em segundo plano. Isso não
contradiz a entrega imediata dos 16 sockets prontos: medir todo handshake na rede
como bloqueio da compra confundiria trabalho concorrente com dependência.

A rede de mint continuou ocupando 10,060 / 10,609 / 9,488 s em intervalos HTTP;
as respostas de relay ocuparam 5,443 / 6,457 / 6,344 s. Esses intervalos se
sobrepõem, inclusive entre as duas carteiras, e não formam uma divisão aditiva do
tempo total. AUTH, ACK, leitura validada e operações de mint continuam necessários.
As estimativas de JavaScript também não transformam todo o restante em culpa do
servidor: incluem-se transporte, agendamento do navegador e espera do protocolo.

### Validação e limites da coleta

As três sessões chegaram a Filled nos dois lados. Depois de recarregar, os saldos
persistiram: A com 9.934 SAT + USD 0,03; B com 60 SAT + USD 99,97. As notificações
WS SPENT foram observadas sob a CSP publicada; quando indisponíveis, HTTP concluiu
a verificação. Artefatos locais sem payloads: `work/profiling-boundaries/capture-warm.json`
e `summary-warm.json`; as versões anteriores foram preservadas.

Tentativas de preparação anteriores à série ficaram fora das estatísticas: a
abertura simultânea inicial dos spares atrapalhou o carregamento do livro; foi
corrigida antes da série acima e a descoberta foi verificada em duas páginas.
Também houve uma entrada de preço abaixo de um centavo e uma falha do seletor de
expansão de listas do roteiro. Nenhuma dessas tentativas iniciou liquidação.

Uma validação manual separada, no navegador do aplicativo, abriu as carteiras
`client-maker-0906` e `client-taker-0906`, deixou-as abertas por mais de 20 segundos
e executou uma venda real de 20 SAT por 1 centavo em Testnut. Resultado: **18,105 s**,
16 conexões prontas (7,4 ms somados), nenhuma conexão fria bem-sucedida, dez tentativas
malsucedidas e quatro notificações WS SPENT. A UI mostrou três ACKs de publicação
nos relays públicos configurados: nos.lol, relay.primal.net e offchain.pub; o inbox
privado usa auth.nostr1.com. ACKs registrados de forma agregada pela UI.
Evento público da ordem: `2efd7c01d5c456067e3e43ea5d647feda8408449f23616bf87c8a7151a60c922`.
Após recarregar, as duas carteiras mantiveram três sessões Filled, incluindo as duas
anteriores, e saldos de 9.934 SAT + USD 0,03 / 60 SAT + USD 99,97.
