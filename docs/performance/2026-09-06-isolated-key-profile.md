# Profiling local das chaves — sem rede

**Reutilizar a chave Nostr já em memória economizou aproximadamente 0,009 ms
(nove microssegundos) por preparação de chaves após aquecimento.** Isso é cerca de
55 mil vezes menor que o objetivo de 500 ms. Na primeira chamada, ambas as variantes
continuam na escala de 16 ms. Não há evidência de uma economia próxima de 0,5 s
na geração/derivação de chaves.

## Resultado isolado

Chrome 151.0.7922.176 nesta máquina. Duas execuções independentes do navegador,
cada uma com 10.000 preparações por variante após aquecimento. A tabela usa a
média das cinco rodadas; cada amostra cronometra dez operações e divide por dez
para reduzir o efeito da resolução do relógio.

| Operação local | Execução 1 | Execução 2 |
|---|---:|---:|
| Gerar/derivar três chaves novas | 0,27827 ms | 0,27791 ms |
| Reutilizar Nostr em memória, gerar/derivar Cashu e refund | 0,26906 ms | 0,26907 ms |
| Economia pareada | **0,00921 ms** | **0,00884 ms** |
| Primeira chamada em contexto novo, três chaves — mediana | 16,1 ms | 16,5 ms |
| Primeira chamada em contexto novo, Nostr reutilizada — mediana | 16,1 ms | 16,2 ms |

A primeira chamada foi medida em cinco contextos novos por variante, alternando
A/B, sem aquecer as rotinas. Não inclui carregar o JavaScript. Ela mede inicialização
criptográfica/JIT ainda presentes; não é uma previsão de todo início de swap, pois
outras ações da página podem aquecer essas rotinas antes.

A função real `localKeys` da branch `51a0300` foi usada nas duas variantes. O caminho
experimental ainda deriva a chave pública Nostr a partir da chave privada existente.
Portanto, não elimina o trabalho de curva elíptica dessa derivação. As primitivas
medidas separadamente na primeira execução foram:

- Gerar chave privada Nostr aleatória e converter para hex: aproximadamente **0,004 ms**.
- Derivar chave pública Nostr de uma chave existente: aproximadamente **0,072 ms**.

As medições primitivas usam 100 blocos de 50 operações. Não subtraímos nem somamos
essas micro-medições para prever o tempo total: JIT, alocações, validações e
conversões diferem entre os limites medidos.

## Custo adicional real da reutilização

A branch não recebe a chave pronta: chama `MakerIdentity.useOrderSecretKey`.
Medi também esse caminho com **IndexedDB real, Web Lock e validação reais**, sem
mint/relay. Não é um mock de armazenamento. Os registros são efêmeros e não contêm
fundos. São 100 amostras após 20 aquecimentos, sem contenção entre abas.

| Ordens guardadas no mapa local | Só buscar/validar chave — mediana | Buscar chave + preparar chaves reutilizando Nostr | Preparar três novas, sem essa leitura extra |
|---|---:|---:|---:|
| 1 | 0,3 ms | 0,5 ms | 0,3 ms |
| 10 | 0,9–1,0 ms | 1,2 ms | 0,3 ms |
| 100 | 7,9 ms | 8,4 ms | 0,3 ms |

A causa do crescimento está em `MakerIdentity.parseStored`: **cada leitura percorre
o mapa e deriva a chave pública de todas as chaves armazenadas para validá-las**.
Essa leitura extra é maior que os nove microssegundos poupados. O teste de 100
ordens é uma análise de escala, não uma afirmação de que havia 100 ordens nos swaps
anteriores. Isso identifica custo local da implementação experimental; não explica
por si só os 300 ms de diferença no teste completo com rede.

Reutilizar também a chave pública ou evitar releituras poderia reduzir parte desse
custo, mas são alternativas não implementadas nem contadas como ganho neste teste.

## Controle e limites

- Depois de carregar somente o bundle local, todos os contextos passam para offline.
  O harness verifica `navigator.onLine === false` na medição aquecida e bloqueia
  qualquer URL externa. **Zero requisições externas nas duas execuções.**
- Não há mint, relay, assinatura de inbox, publicação, criptografia de mensagens,
  persistência de sessão ou liquidação dentro do trecho `localKeys` medido.
- A variante com armazenamento é cronometrada separadamente e inclui sua leitura
  extra. Nada é atribuído ao processamento dos terceiros.
- A/B e B/A alternam a cada amostra; 100 aquecimentos por variante precedem cinco
  rodadas de 200 pares, dez operações por amostra. As chaves são geradas de verdade,
  com as validações da função original, sem resultados ou material privado nos logs.
- O navegador não é um ambiente de tempo real: GC, JIT, scheduler e resolução do
  relógio ainda variam. A repetição e o agrupamento reduzem esse ruído; não alegamos
  determinismo absoluto nem usamos a resolução submilissegundo como precisão absoluta.
- Os p95 dos arquivos referem-se às médias dos blocos no trecho aquecido, e às
  operações individuais no trecho IndexedDB. São medidas com limites diferentes.

## Reproduzir

Na branch `perf/order-key-experiment`, com dependências do projeto e Playwright
já disponíveis (nenhuma dependência nova foi adicionada):

```sh
PLAYWRIGHT_MODULE=/caminho/para/playwright/index.mjs node scripts/key-profile.mjs resultado.json
```

Se `playwright` estiver resolvível normalmente, a variável pode ser omitida.
O runner compila um bundle temporário que exporta as duas funções privadas apenas
para instrumentação; o código da aplicação permanece sem essas exportações.
Ele valida comprimentos/independência das chaves, exige execução offline, bloqueia
rede externa e elimina o bundle temporário ao terminar. Executou duas vezes com
sucesso, além dos 440 testes da branch já registrados no experimento anterior.

[Execução 1](2026-09-06-isolated-key-profile.json) ·
[Execução 2](2026-09-06-isolated-key-profile-repeat.json)

**Decisão:** manter o isolamento por reserva. A parte de geração/derivação das
chaves, isoladamente, não oferece os 500 ms procurados. A redução de operações de
inbox é uma hipótese diferente e não está incluída nesta micro-medição.
