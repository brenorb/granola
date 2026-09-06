# Profiling das duas carteiras: o que o Granola controla

O principal alvo é reduzir **idas à rede e dependências sequenciais criadas pelo
cliente**. O JavaScript das carteiras não ocupa quatro segundos contínuos do swap.
Também não é correto atribuir todo intervalo de rede à mint ou ao relay: abrir uma
conexão desnecessária continua sendo uma decisão nossa.

## Versão e método

Este perfil usa o código **já otimizado**, servido em
<https://brenorb.com/granola/>, asset `index-C6t8p8eS.js`. São **12 requisições de
metadata por swap**. As 81–84 pertencem ao baseline anterior; não são uma pendência
desta versão.

Foram feitos seis swaps reais de Testnut pela interface, três exploratórios e três
com captura de CPU iniciada e encerrada separadamente por operação. Dois perfis de
carteira em duas abas do Chrome no mesmo Mac; SAT em `testnut.cashu.space` e USD em
`nofee.testnut.cashu.space`. Não são dois computadores nem um teste de carga.
O Chrome estava headless: interação com a interface real por Playwright, sem mocks
ou chamadas diretas às funções internas do protocolo.

Janela: clique para tomar a ordem até o último `Filled` das duas carteiras.
Funding e publicação inicial da ordem ficam fora. As páginas foram recarregadas
entre amostras. Medimos HTTP e WebSocket com CDP, execução JavaScript por amostragem
a cada 1 ms, transações IndexedDB, espera de Web Locks e chamadas Web Crypto.
O source map foi produzido a partir do snapshot limpo e corresponde ao mesmo hash
do JavaScript publicado. Nenhum payload de rede, token, chave ou witness foi
armazenado pelo coletor de rede.

## Resultados da captura revisada

| Medida | Venda 1 | Compra 2 | Venda 3 |
| --- | ---: | ---: | ---: |
| Até ambas as carteiras concluírem | 24,277 s | 31,723 s | 24,987 s |
| JavaScript carteira A, incluindo dependências | 0,741 s | 0,664 s | 1,208 s |
| JavaScript carteira B, incluindo dependências | 0,657 s | 0,837 s | 1,059 s |
| Transações IndexedDB, ambas as carteiras | 641 | 634 | 646 |
| União dos intervalos de transações IndexedDB | 1,009 s | 1,246 s | 1,835 s |
| Espera por Web Locks, união | 0,202 s | 0,254 s | 0,324 s |
| Novas conexões com relays | 20 | 21 | 20 |
| União dos handshakes de relay | 5,541 s | 6,480 s | 5,969 s |
| HTTP efetivo: metadata / checkstate / swap / restore | 12 / 10 / 4 / 4 | 12 / 10 / 4 / 4 | 12 / 11 / 4 / 4 |
| Preflights HTTP OPTIONS adicionais | 18 | 18 | 19 |
| União dos intervalos HTTP das mints, incluindo preflight | 9,309 s | 12,681 s | 9,057 s |
| Esperas de proof WS: SPENT / unavailable | 4 / 0 | 3 / 1 | 2 / 3 |

**As linhas de tempo não são parcelas somáveis.** As carteiras trabalham em
paralelo; CPU, IndexedDB, rede e espera pelo outro participante se sobrepõem.
“União” conta cada instante uma vez dentro daquela categoria. Não significa
tempo integralmente removível do caminho até `Filled`.

Os números de JavaScript são estimativas do profiler, incluindo bibliotecas.
Não incluem todo trabalho nativo do navegador, disco, rede ou outros threads.
Amostras `(program)` não foram promovidas a uma estimativa de CPU do Granola.
Houve uma long task de 51 ms na terceira amostra; as outras duas não registraram
long tasks. A instrumentação adiciona algum custo.

Os três swaps exploratórios levaram 26,002 s, 25,333 s e 24,405 s. A captura de
CPU que atravessou reloads nessa série não foi usada para comparar CPU entre runs.
Não há amostras suficientes para estimar p95, variabilidade de produção ou um
ganho futuro garantido.

## Onde podemos agir

### 1. Reutilizar conexões de relay dentro do mesmo contexto de identidade

No primeiro swap foram sete conexões a `nos.lol`, sete a `relay.primal.net` e seis
a `auth.nostr1.com`. Também ocorreram seis autenticações e dez consultas de
kind 10050. Parte das consultas de order book ocorre em segundo plano.

`src/nostr/inbox-relay.ts` abre e fecha uma conexão em cada `publish()` e `query()`.
`publishInboxList()` em `src/nostr/inbox.ts` publica e depois faz readback exato,
abrindo outra conexão para esse segundo passo.

**Mudança prioritária:** usar a mesma conexão para publicação e readback da mesma
operação. Depois, avaliar reutilização limitada ao mesmo relay e contexto de AUTH.
Não misturar chaves de reservas diferentes. Isso reduz handshakes sem mudar o
critério de confirmação ou retirar validações.

Os 5,5–6,5 s de handshakes mostram a dimensão do trabalho observado; **não são uma
promessa de economia desse tamanho**. Algumas conexões são necessárias ou ocorrem
em paralelo. O ganho deve ser medido após uma alteração isolada.

### 2. Reduzir leituras e reaberturas do armazenamento local

`IndexedDbStorageDriver.request()` abre o banco e o fecha para cada acesso.
`EncryptedStorageDriver.encryptionKey()` busca a mesma chave persistida novamente
para cada leitura/escrita criptografada, sob um lock.

**Mudança pequena e concreta:** manter uma conexão IndexedDB por driver e reutilizar
o `CryptoKey` já validado durante a vida do perfil. Fechar/invalidate em reset e
`versionchange`; preservar isolamento entre perfis e criação concorrente da chave.
Não cachear saldo ou estado de proofs indiscriminadamente.

Na terceira amostra, a validação/conversão dos arrays do envelope criptografado
consumiu aproximadamente 316 ms de amostras JS somando as duas carteiras; o callback
de leitura do IndexedDB, 206 ms. Aumentaram conforme o histórico cresceu, mas três
amostras não provam uma relação de escala.

As chamadas nativas instrumentadas de encrypt/decrypt/digest somaram apenas
13–17 ms por swap. Isso não inclui a criptografia síncrona de Nostr/Cashu, que
aparece nas amostras das dependências. O alvo é a repetição de I/O e serialização,
não enfraquecer a criptografia.

### 3. Tirar descobertas de inbox do caminho sequencial quando forem independentes

`discoverInbox()` em `src/nostr/trade-transport.ts` espera `Promise.all` das consultas
aos relays configurados antes de selecionar a lista válida. `stageOutgoing()` em
`src/trade/effects.ts` só então prepara o corpo da mensagem.

No primeiro swap, preparar as três mensagens levou cerca de 1,10 s, 1,03 s e
1,03 s, incluindo a descoberta. Pode-se antecipar uma descoberta quando destinatário
e contexto já estiverem definidos, sobrepondo-a a trabalho independente.
Uma mudança para “primeira resposta vence” exige avaliar a seleção da lista mais
recente; não é equivalente ao comportamento atual. Este é um alvo para protótipo
medido, com mais risco que reutilizar a conexão da mesma operação.

### 4. Evitar consultas de recuperação desnecessárias durante espera saudável

No primeiro swap, o taker esperou de 5,190 s a 10,191 s; o watchdog disparou uma
consulta vazia de aproximadamente 1 s. A mensagem esperada só chegou ao socket
persistente aos 12,767 s, e a espera acordou aos 12,776 s.

Portanto, **não existem cinco segundos de resposta pronta esquecida** nesse caso.
O outro navegador ainda preparava a aceitação. Podemos reduzir a consulta extra
enquanto a assinatura está saudável, preservando recuperação após desconexão.
O ganho comprovado aqui seria menos tráfego; ganho na duração total ainda não foi
demonstrado.

### 5. Tratar preflight CORS como uma fronteira a investigar

No primeiro swap, 18 OPTIONS acumularam 4,26 s de duração, distribuídos entre os
dois clientes. Eles estão incluídos no tempo dos respectivos POSTs e **não devem
ser somados novamente**. Cada POST aguardou aproximadamente 230–240 ms antes do
envio efetivo, majoritariamente pelo preflight.

A mint sem taxas respondeu `Access-Control-Max-Age: 600`; a outra não enviou esse
header nas respostas observadas. Mesmo assim houve OPTIONS repetidos. O cliente
cashu-ts usa `cache: "no-store"`, mas este perfil **não demonstrou a causa da
repetição do preflight**, nem que trocar essa opção resolveria o problema.

Reduzir chamadas redundantes é nosso trabalho. A política CORS aceita pelo servidor
depende da mint. Um experimento específico pode verificar o cache de preflight,
mantendo as respostas financeiras sempre frescas. Não recomendar cache de
`checkstate`, `swap` ou `restore` a partir destes dados.

### 6. Renderização é prioridade menor

`renderActivityLog()` substitui toda a lista a cada atualização. Na terceira amostra
esse ponto teve aproximadamente 78 ms de CPU amostrada somando as carteiras.
Agrupar atualizações pode ajudar com históricos maiores, mas não explica dezenas
de segundos nem deve preceder a remoção de reconexões e I/O repetido.

## O que realmente depende de terceiros

Depois que o cliente envia uma requisição necessária, transporte, processamento da
mint/relay e entrega da resposta estão fora do nosso controle direto. CDP mede esse
intervalo observado, **não separa CPU do servidor de latência de rede**.

No primeiro swap, os quatro POSTs `/swap` acumularam 1,222 s entre fim do envio e
início dos headers de resposta, mais 0,919 s de OPTIONS. Isso é muito diferente de
atribuir a eles toda a fase do coordenador que contém o swap.

Espera por `SPENT` também pode ser espera pelo outro navegador executar o claim.
Não é automaticamente lentidão da mint. Na captura revisada, a segunda e terceira
amostras tiveram indisponibilidade de proof WS e usaram o fallback HTTP; a conclusão
permaneceu correta. O perfil não identifica a causa remota desses erros.

Os quatro swaps e as validações independentes de estado/witness são trabalho do
protocolo, não redundância demonstrada. Também não se deve apagar checkpoints de
recuperação simplesmente porque aparecem no caminho medido.

## Validação e próximos critérios

Os três swaps revisados terminaram sem Refresh Swaps ou intervenção de recuperação.
Ambas as carteiras registraram três operações Filled; após reload, mantiveram os
saldos esperados: A com 9.934 SAT + USD 0,03; B com 60 SAT + USD 99,97, incluindo as taxas.
Somente fundos fictícios Testnut foram usados.

Não houve alteração no runtime nesta etapa de profiling. Para cada otimização,
comparar a mesma interface com a mesma quantidade de operações, reportando duração
total, conexões/AUTH, HTTP por método, IndexedDB e CPU. Preservar validação de
proofs e testes de retomada/desconexão. Medir também sessões com histórico maior.

Ordem recomendada: **reutilização de conexão no publish/readback; conexão IndexedDB
e chave do perfil; descoberta antecipada; agendamento de recuperação; renderização.**
O objetivo verificável é minimizar trabalho e round trips evitáveis dos clientes,
mantendo o protocolo seguro. Não é possível prometer zero tempo local.

## Artefatos locais

- `work/profiling-boundaries/capture-v2.json`: captura revisada, com categorias,
  contagens, tempos, amostras de stack e timeline da aplicação.
- `work/profiling-boundaries/summary-v2.json`: agregação por operação/carteira.
- `work/profiling-boundaries/run.mjs` e `attach.js`: coletor e fluxo de UI.
- `work/profiling-boundaries/analyze.mjs`: análise usando source map correspondente
  ao asset. O caminho do mapa aponta para o snapshot local desta investigação.

Executar o runner faz novos swaps de teste reais pela UI; não é um teste offline.
