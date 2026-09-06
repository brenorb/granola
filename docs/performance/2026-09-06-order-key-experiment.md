# Experimento: reutilizar a chave Nostr da ordem

Branch `perf/order-key-experiment`, baseada em `ff5a823`. Critério pedido: reduzir
a duração completa em pelo menos 500 ms; caso contrário, manter chaves por reserva.
Baseline `index-Bo3I8QwM.js`; candidato `index-BTzMJnIl.js`.

**Resultado: manter as chaves por reserva na main.** Nenhum dos três pares válidos
atingiu a redução mínima de 500 ms. A branch permanece experimental, sem merge.

| Par concluído | Chave por reserva | Chave da ordem | Experimento menos baseline |
|---|---:|---:|---:|
| 1 — A/B | 13,574 s | 13,879 s | +0,305 s |
| 2 — A/B | 13,525 s | 13,643 s | +0,118 s |
| 3 — B/A, após pausa | 13,847 s | 14,276 s | +0,428 s |
| Mediana | **13,574 s** | **13,879 s** | **+0,305 s** |

A amostra não prova que reutilizar a chave cause lentidão: a latência externa varia.
Ela não sustenta o ganho de 500 ms exigido para trocar o isolamento por reserva.

## O que foi testado

O maker usa a chave Nostr da ordem, reaproveita a assinatura de recebimento já
aberta e deixa de publicar uma segunda inbox por reserva. A sessão persiste uma
cópia criptografada da chave para sobreviver à remoção da identidade da ordem;
se o listener da ordem desaparecer, a sessão retoma seu próprio listener.
As chaves Cashu e de reembolso continuam independentes. Validação de assinaturas,
termos, sessão, transcript, exclusividade local e checkpoints financeiros continuam
ativos. Não foram introduzidas mudanças na mint ou nos relays.

A exceção à ADR 0003 está documentada somente nesta branch: o taker experimental
aceita a chave da ordem como chave Nostr de sessão. Um taker antigo rejeita essa
aceitação. Reutilizar a chave prolonga sua retenção através das reservas e perde
o isolamento criptográfico entre elas. A branch não foi promovida para produção.

## Método

Builds de produção servidos localmente, mesma máquina e Chrome, mints reais
Testnut SAT e nofee Testnut USD, relays reais. Swaps de 20 SAT por um centavo de
USD, com 20 s de navegação antes da publicação. Medida do clique do taker até o
último Filled nas duas carteiras. Intervalos simultâneos não são somados.

Primeira série alternada A/B: dois pares concluídos. O terceiro candidato recebeu
HTTP 429 da mint nofee no POST swap e não concluiu dentro de 120 s; esse par não
entra na comparação de latência. Um teste automatizado local também ocorreu durante
essa execução descartada. A repetição inverte a ordem B/A, após uma pausa, com um
minuto entre execuções e sem testes concorrentes durante os swaps.

O primeiro harness salvava o arquivo completo somente ao terminar; os tempos dos
pares concluídos foram preservados pelo console. O harness de repetição salva cada
execução imediatamente. Não contamos a execução interrompida como sucesso nem
atribuímos seu timeout ao custo da chave.

## Verificação

440 testes passaram, 7 ignorados. Incluem compra/venda usando a chave da ordem,
observações pendentes da mint, rejeição de chave que não corresponde à ordem,
separação das chaves Cashu e retomada do listener depois da remoção da identidade.
Build e typecheck passaram. Os testes de concorrência, replay, desconexão e
recuperação existentes também passaram; isso não equivale a certificar esta variante
para produção ou clientes antigos.

## Conexões e requisições da repetição B/A

| Operações no intervalo do swap | Isolada | Compartilhada |
|---|---:|---:|
| Aquisições de conexão aquecida | 9 | 6 |
| Aquisições que falharam | 4 | 2 |
| Consultas kind 10050 | 6 | 4 |
| Consultas kind 1059 | 2 | 1 |
| Consultas kind 30078 | 6 | 6 |
| Publicações Nostr | 11 | 9 |
| Autenticações Nostr | 5 | 4 |
| Metadata HTTP | 12 | 12 |
| POST swap / restore / checkstate | 4 / 4 / 10 | 4 / 4 / 10 |

Reutilizar a identidade efetivamente retirou operações de relay. Isso não se
traduziu em menor tempo total: grande parte do trabalho retirado já ocorria em paralelo.
Na repetição, a união temporal HTTP da mint foi 9,451 s isolada e 9,738 s
compartilhada; a união das respostas Nostr, 3,189 s e 2,906 s. A união de toda
atividade de rede rastreada foi 12,508 s e 12,927 s. Essas linhas se sobrepõem,
incluem tarefas de fundo e **não devem ser somadas** nem tratadas como CPU externa.

A geração/derivação local das chaves do maker levou 1,7 ms isolada e 13,5 ms
compartilhada nesta repetição. Como a ordem/JIT mudou e a execução compartilhada
veio primeiro, isso não isola o custo da chave removida; ambos estão na escala de
milissegundos, não perto dos 500 ms necessários.

Dados sem material financeiro: [resultados agregados](2026-09-06-order-key-experiment.json).

## Validação manual adicional

Na interface do navegador integrado, build experimental `index-BTzMJnIl.js`:
**16,215 s**, ambas as carteiras Filled, quatro notificações SPENT por WebSocket,
publicação inicial com três ACKs. Após recarregar: maker 9.978 SAT + USD 0,01;
taker 20 SAT + USD 99,99; um Filled em cada carteira. Esta execução confirma o fluxo
e a persistência, mas não entra na comparação A/B por usar outro navegador.

Decisão final: preservar a implementação e evidência nesta branch experimental;
**não fazer merge nem deploy da reutilização de identidade**. A main mantém a chave
Nostr nova por reserva e seu isolamento.
