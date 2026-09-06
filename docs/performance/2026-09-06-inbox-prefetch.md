# Antecipação da descoberta de inbox — 2026-09-06

## Mudança incremental

Os tempos de 1,10 / 1,03 / 1,03 s em `2026-09-06-wallet-boundaries-profile.md`
são históricos. A versão `ae25679` já usa rotas diretamente autenticadas e antecipa
fallback de descoberta durante a execução do bloqueio na mint. Não implementamos
outro cache nem voltamos a consultar kind 10050 quando a rota direta é válida.

Agora maker e taker iniciam a antecipação durante a publicação da própria inbox
quando já conhecem o próximo destinatário. Antes de preparar um bloqueio, também
iniciam a consulta; o ponto de execução permanece como fallback para retomadas de
um checkpoint preparado. Os três pontos compartilham a mesma promessa por sessão,
identidade local, destinatário e tipo de mensagem.

A promessa não é aguardada na preparação, execução ou reconciliação financeira.
Somente a montagem da mensagem a consome. O cache permanece limitado a 32 entradas,
com validade de 10 segundos e uso único; falha ou expiração exige nova consulta.
A validade também é verificada depois de aguardar uma consulta pendente, usando
um relógio monotônico para incluir essa espera. Eventos de inbox continuam validados
para o destinatário e o instante de uso. Mensagens, identidades por reserva,
reservas de proofs, checkpoints e recuperação idempotente não foram alterados.

## Validação automatizada

436 testes passaram, 7 ignorados; typecheck e build de produção isolado passaram.
Os testes verificam antecipação antes da preparação da mint para aceitação, base
lock e quote lock; consulta sem resposta não bloqueia preparação, resultado
financeiro ou reconciliação; reuso, falha, expiração antes e durante a espera,
isolamento por sessão e identidade, e retomada de operação preparada.

## Swaps reais e comparação

Build anterior `index-DR0O-JUR.js` (`ae25679`) versus build desta mudança
`index-Bo3I8QwM.js`. Três swaps pela interface Chrome, venda/compra/venda,
20 SAT por 1 centavo, Testnut SAT e nofee Testnut USD. Ambas as carteiras navegam
por 20 segundos antes da ordem. O cronômetro começa no clique do taker e termina
no último Filled entre as duas carteiras.

| Medida | Antes | Depois |
|---|---:|---:|
| Venda 1 | 14,227 s | 14,930 s |
| Compra 2 | 13,772 s | 13,898 s |
| Venda 3 | 14,120 s | 13,556 s |
| Mediana | 14,120 s | 13,898 s |
| Preparar proposta — três execuções | 17,2 / 19,4 / 29,3 ms | 17,6 / 17,3 / 27,5 ms |
| Preparar aceitação | 41,4 / 33,9 / 38,6 ms | 36,0 / 34,6 / 37,6 ms |
| Preparar quote lock | 18,7 / 40,7 / 22,6 ms | 18,8 / 33,1 / 30,5 ms |
| Aquisições de conexão aquecidas / frias concluídas | 9 / 0 | 9 / 0 |
| Aquisições que falharam, incluindo livro | 4 | 4 |
| Consultas kind 10050 / 30078 / 1059 | 6 / 6 / 2 | 6 / 6 / 2 |
| Metadata HTTP / swap / restore | 12 / 4 / 4 | 12 / 4 / 4 |
| Checkstate HTTP | 10 / 10 / 11 | 10 / 10 / 11 |

A diferença de mediana é **222 ms (1,6%)**, sem evidência suficiente para atribuí-la
à mudança: amostra pequena, terceiros variáveis, baseline servido em produção e
candidato pelo preview local de um build de produção isolado. Os swaps usam mints
e relays reais nos dois casos. A navegação e carga de assets ficam fora do cronômetro.
As rotas diretas já retiravam descoberta da preparação dessas mensagens; os testes
controlados verificam o fallback sem rota direta. Não alegamos novo ganho de 3 s.

Depois, a união dos intervalos HTTP de mint foi 10,412 / 9,211 / 9,081 s; a união
das respostas Nostr foi 3,316 / 3,185 / 2,964 s. A união de toda atividade de rede
rastreada foi 13,836 / 12,764 / 12,053 s. **Não some essas linhas:** elas se sobrepõem
e incluem anúncios e reposição de conexões em segundo plano. Nem toda atividade
externa observada bloqueia o swap; estes valores não medem CPU do servidor.

Após os três swaps e recarregamento, ambas as carteiras exibiram três Filled:
A = 9.934 SAT + USD 0,03; B = 60 SAT + USD 99,97. As execuções registraram
4 / 4 / 2 assinaturas de estado da mint; o fallback HTTP permaneceu funcionando.
As requisições OPTIONS estão separadas nos [dados agregados](2026-09-06-inbox-prefetch.json).
Nenhuma captura de bearer material foi incluída.
