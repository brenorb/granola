# Otimizações locais coordenadas — 2026-09-06

Quatro subagentes GPT-5.6 Luna com raciocínio High pesquisaram e implementaram
em worktrees separados. A revisão integrou duas mudanças mínimas na branch
`perf/local-performance`, preservando o checkout principal e seu trabalho de SDK.

| Frente | Resultado |
|---|---|
| Journal | Reutilizar a sessão já persistida para iniciar anúncios; sem cache entre ações. Leituras por transição local 2→1 e externa 3→2. CAS e releitura sob lock antes de gravar continuam. |
| Armazenamento | IV/ciphertext em Uint8Array, leitura de arrays antigos, AES-GCM e chave não extraível preservados. IndexedDB v2 invalida conexões antigas sem apagar dados. |
| Metadados | Sem prewarm adicional: o refresh explícito do preflight manteria 12 requests após o clique e somaria tráfego antes dele. Uma política de frescor diferente continua sendo oportunidade nossa, ainda não validada. |
| Proofs | Sem registro compartilhado: não foi encontrada duplicação concorrente alcançável para o mesmo conjunto. O protótipo foi removido. Notificações continuam seguidas de NUT-07 e validação de witness. |

## Ganho isolado

Chrome 151.0.7922.176, IndexedDB real, três contextos isolados, oito amostras
alternadas por operação/contexto, payload sintético de 92.140 bytes e zero
requisições HTTP externas. Leitura: 3,2–3,3→0,4 ms; escrita: 3,7–3,9→0,5–0,6 ms.
O benchmark verifica a invalidação da conexão v1, preservação/leitura dos dados
antigos, escrita/leitura binária e rejeição do cliente v1. Todos passaram.

Dados: [benchmark isolado](2026-09-06-storage-binary-browser.json).
O tamanho é sintético; não representa uma medição do tamanho das carteiras reais.

## Profiling com Testnut

Baseline histórico `ff5a823`, asset `index-Bo3I8QwM.js`, comparado ao candidato
`0b96a42`, asset `index-Dxpkh-Z1.js`. Mesma instrumentação, Chrome, duas carteiras
novas, venda/compra/venda, 20 SAT por 1 centavo e 20 segundos navegando antes de
cada ordem. Testnut SAT e nofee Testnut USD, mints/keysets distintos. O cronômetro
vai do clique do taker ao último Filled entre os participantes.

| Medida | Baseline histórico | Candidato |
|---|---:|---:|
| Duração, três swaps | 14,930 / 13,898 / 13,556 s | 16,538 / 16,804 / 13,606 s |
| CPU JS atribuída ao app e dependências, somada entre carteiras | 1,372 / 1,739 / 2,022 s | 1,115 / 1,086 / 1,536 s |
| Operações IndexedDB | 398 / 390 / 397 | 358 / 350 / 356 |
| Descriptografias | 239 / 243 / 249 | 199 / 203 / 208 |
| União dos intervalos IndexedDB | 282 / 414 / 465 ms | 199 / 230 / 337 ms |
| Metadata / swap / restore HTTP | 12 / 4 / 4 | 12 / 4 / 4 |
| Checkstate HTTP, por execução | 10 / 10 / 11 | 10 / 10 / 11 |
| Kind 10050 / 30078 / 1059 | 6 / 6 / 2 | 6 / 6 / 2 |
| Aquisições relay warm / cold / failed | 9 / 0 / 4 | 9 / 0 / 4 |

O ganho determinístico é eliminar uma releitura por transição e trocar a
representação de bytes. As contagens reais confirmam 40–41 leituras/operações
IndexedDB e descriptografias a menos no fluxo observado. A CPU atribuída por
carteira ficou em 0,470–0,786 s, versus 0,621–1,031 s no histórico.

**Não é um A/B contemporâneo aleatorizado.** A mediana total subiu, enquanto a
CPU JS atribuída e o trabalho de storage caíram. Não concluímos que a mudança
causou essa alta, nem atribuímos cada milissegundo residual a terceiros. No
candidato, a união HTTP foi 11,506 / 11,206 / 9,238 s e a união de respostas Nostr
4,454 / 3,568 / 3,239 s. Os intervalos são sobrepostos e incluem trabalho de fundo.
O segundo swap também contém 1,915 s na categoria runtime/probe não atribuída;
isso não foi classificado como CPU do Granola.

Não some CPU de duas carteiras, IndexedDB, filas de locks ou rede como duração
sequencial. Lock mantido enquanto aguarda rede não é CPU local. Os dados não
estabelecem um total exclusivo do caminho crítico local. Os 12 requests de
metadata são uma decisão do nosso cliente, não uma demora inevitável da mint.

Dados agregados: [antes/depois](2026-09-06-local-performance.json).
Depois dos três swaps e reload: ambas as carteiras com três Filled; A=9.934 SAT
+ USD 0,03, B=60 SAT + USD 99,97.

## Validação manual e automatizada

442 testes passaram e 7 foram ignorados; typecheck e build passaram. A suite
inclui CAS, concorrência entre coordenadores, erro/resposta perdida, retry,
checkpoints e retomada de anúncios. O teste real de upgrade está no benchmark de
navegador, além dos testes de invalidação/upgrade bloqueado.

Um swap adicional executado manualmente pela interface no mesmo asset levou
14,6905 s, com ambas as carteiras Filled e quatro notificações SPENT. Maker:
9.978 SAT + USD 0,01; taker: 20 SAT + USD 99,99. Saldos e um Filled por carteira
persistiram após reload de ambas. Não foram removidas validações
financeiras nem alteradas as chaves por reserva.

## Publicação e compatibilidade

Mudanças ficam na branch de integração; este relatório não afirma deploy.
O upgrade mantém registros existentes e solicita recarregamento de abas antigas.
Após escrita binária, rollback precisa de leitor dual e IndexedDB v2; o build
antigo v1 falha fechado com VersionError. Nenhum banco é apagado no upgrade.
