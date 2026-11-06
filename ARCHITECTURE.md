# Arquitetura e decisões

O objetivo foi ser **correto antes de ser sofisticado**. Toda invariante financeira tem duas barreiras: o código de domínio, que dá erros legíveis, e o **schema do PostgreSQL**, que é a garantia final e vale para qualquer número de instâncias.

## Sumário

1. [Visão geral e camadas](#1-visão-geral-e-camadas)
2. [Dinheiro (`Money`)](#2-dinheiro-money)
3. [ORM e estratégia transacional](#3-orm-e-estratégia-transacional)
4. [Concorrência](#4-concorrência)
5. [Schema: garantias no banco](#5-schema-garantias-no-banco)
6. [Regras de negócio e máquina de estados](#6-regras-de-negócio-e-máquina-de-estados)
7. [Taxonomia de `failureCode`](#7-taxonomia-de-failurecode)
8. [Idempotência](#8-idempotência)
9. [Referências fora de ordem](#9-referências-fora-de-ordem)
10. [SQS: consumidor, inbox, retry e DLQ](#10-sqs-consumidor-inbox-retry-e-dlq)
11. [Transactional outbox e eventos](#11-transactional-outbox-e-eventos)
12. [Reconciliação](#12-reconciliação)
13. [Observabilidade](#13-observabilidade)
14. [Autenticação](#14-autenticação)
15. [Interpretações do enunciado](#15-interpretações-do-enunciado)
16. [Trade-offs e limitações](#16-trade-offs-e-limitações)

---

## 1. Visão geral e camadas

```
interfaces/http (NestJS)          infrastructure/messaging (SQS consumer)
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
        application: SubmitWagerTransaction  ← o MESMO caso de uso para HTTP e SQS
                       │      OpenWallet · ProcessPendingReferences · ReconcileWallet · Queries
                       ▼
        domain: Money · Wallet · WagerTransaction · WalletLedgerEntry · WagerSettlement
                InboxMessage · OutboxMessage · IntegrationEvent (+ subclasses)
                       ▲
        infrastructure: MikroOrmUnitOfWork · repositórios SQL · PgOutboxStore · OutboxPublisher
                        PendingReferenceWorker · pino · prom-client
```

- **Domínio puro.** Não tem decorators do Nest nem tipos do ORM. Todas as classes têm construtor `private` e factories estáticas (`create`/`open`/`from`/`receive`/`enqueue` e `rehydrate`). A factory `rehydrate` só reconstrói o estado, sem revalidar transições.
- **`WagerSettlement`.** É um serviço de domínio sem I/O que aplica as regras da seção 7. Os testes unitários de BET/WIN/LOSS/REFUND/ROLLBACK exercitam esse serviço diretamente.
- **Portas.** `application/ports.ts` declara `UnitOfWork`, os repositórios, `Clock`, `IdGenerator`, `Metrics` e `FaultInjector`. As implementações ficam em `infrastructure`.
- **Composition root (`src/composition.ts`).** Monta o grafo de objetos sem framework, e o Nest só recebe o resultado. Os testes de integração usam **o mesmo** `buildCore`, então não existe um wiring de teste diferente do de produção.
- **Um binário, três papéis (`APP_ROLE`):**
  - `api`: só HTTP;
  - `worker`: consumidor SQS, publisher da outbox e worker de referências;
  - `all`: os dois.

  O compose sobe 3 instâncias `all`. Em produção os papéis podem escalar separados.

## 2. Dinheiro (`Money`)

- **Representação.** O valor fica em `decimal.js`, num **clone isolado** (`Decimal.clone({ precision: 40 })`) que nunca toca a configuração global da lib. Em contratos e eventos o valor é sempre uma **string decimal com escala 2** (`"25.00"`). `number` nunca representa dinheiro, em nenhuma camada.
- **Política de arredondamento: rejeitar.** A entrada precisa casar `^(0|[1-9]\d{0,17})\.\d{2}$`. Ficam de fora:
  - `NaN`, `Infinity` e notação científica;
  - string vazia e espaços;
  - sinal (`-1.00`, `+1.00`) e zeros à esquerda;
  - `"10.5"` (escala diferente de 2) e `"10.005"` (mais de 2 casas).

  Arredondar faria a API aceitar um valor que o provedor não mandou. O domínio só soma e subtrai, então nunca precisa arredondar.
- **Imutável.** Toda operação devolve uma instância nova. Operar moedas diferentes lança `CurrencyMismatchError`. O modelo é multi-moeda, com uma wallet por `(playerId, currency)`, e os conflitos de moeda são testados.
- **Persistência.** O valor e a moeda ficam em colunas separadas. O valor usa o **domínio SQL `money_amount`**: `numeric` **sem precisão declarada** + `CHECK (VALUE <> 'NaN' AND VALUE >= 0 AND scale(VALUE) = 2 AND VALUE < 10^18)`.
  - **Por que não `numeric(20,2)`:** o PostgreSQL faz o cast para o tipo da coluna antes do CHECK. Com `numeric(20,2)`, `10.005` seria **arredondado em silêncio** para `10.01`. Sem precisão declarada, a escrita é **recusada**.
  - **Por que excluir `NaN` explicitamente:** no PostgreSQL, `'NaN'::numeric >= 0` é **verdadeiro**, porque NaN é ordenado acima de todos os números.
  - **Leitura:** todo `numeric` é lido com `::text` e vira `Money.from(...)`, então o driver nunca converte para `number`.

## 3. ORM e estratégia transacional

**MikroORM 7, a opção preferida do enunciado,** é usado no que resolve bem aqui:

- `orm.em.fork()`: cada tentativa ganha um EntityManager e um Identity Map isolados;
- `transactional()` com **isolamento explícito** (`READ COMMITTED`, ou `REPEATABLE READ` + `readOnly` para a reconciliação);
- `em.execute()` dentro da transação;
- o pool;
- o **Migrator**, com migrations versionadas e reversíveis (`up`/`down` testados).

**Por que não há entidades mapeadas.** As queries que importam são específicas:

- `SELECT … FOR UPDATE`;
- `UPDATE … WHERE version = ?`;
- `INSERT … ON CONFLICT DO NOTHING`;
- claim com `FOR UPDATE SKIP LOCKED`;
- soma em `NUMERIC`.

Com SQL explícito nos repositórios, o que vai ao banco é exatamente o que está escrito, e o domínio não depende de flush automático nem do Identity Map. O preço é escrever os mappers à mão (`pg-repositories.ts`). Com entidades mapeadas eu teria duas classes por conceito (entidade de domínio e entidade ORM) para ganhar pouco.

**Unit of Work (`MikroOrmUnitOfWork`):**

- tudo de uma operação roda numa transação: inbox (se vier de SQS), transação de aposta, saldo, ledger e outbox;
- `lock_timeout = 2s` e `statement_timeout = 10s` são aplicados com `set_config(..., true)` (equivale a `SET LOCAL`), então valem só para a transação e não vazam para a conexão do pool;
- **retry da transação inteira** em `55P03` (lock timeout), `40P01` (deadlock), `40001` (serialization), corrida de unicidade nas chaves de idempotência/inbox e perda de conexão. São no máximo 4 tentativas, com backoff exponencial + jitter. O callback relê tudo do banco: **nenhum estado de domínio mutado numa tentativa abortada é reaproveitado**;
- esgotadas as tentativas, lança `TransientInfrastructureError`, que vira `503` + `Retry-After` no HTTP e retry com backoff no SQS;
- violações de constraint de negócio **não** são retentadas.

## 4. Concorrência

**Unidade de concorrência: `walletId`. Estratégia: lock pessimista por linha + `version` como defesa em profundidade.**

1. Toda operação que pode mudar saldo começa com `SELECT … FROM wallets WHERE id = ? FOR UPDATE`. O lock é do PostgreSQL, então vale para **todas as instâncias**. Não existe lock em memória nem lock global, e wallets diferentes não se bloqueiam.
2. Sob `READ COMMITTED`, cada statement depois do lock enxerga o commit da transação anterior. No cenário obrigatório (100.00 e duas BETs de 80.00), a segunda BET lê 20.00 e é rejeitada com `INSUFFICIENT_FUNDS`. Não há lost update.
3. O saldo é gravado com `UPDATE … SET version = ? WHERE id = ? AND version = ?`. Sob o lock isso nunca falha. Se falhar, alguém escreveu sem lock, e o erro é explícito em vez de sobrescrever.
4. No schema:
   - `UNIQUE (wallet_id, wallet_version)` no ledger: dois lançamentos para a mesma versão são impossíveis;
   - trigger: `version` só muda junto com o saldo, e sempre `+1`;
   - **constraint trigger `DEFERRED`**: no COMMIT, a versão atual da wallet precisa ter um lançamento cujo `balance_after` seja o saldo materializado.

   Assim, um lost update ou um saldo alterado sem ledger **viram violação de schema**.

**Por que pessimista e não otimista.** O caso difícil é a hot wallet. Com lock otimista, N transações concorrentes geram N−1 conflitos e N−1 refações completas, uma tempestade de retries. Com lock pessimista, elas entram na fila do próprio PostgreSQL, com custo previsível (medido: ~7 ms por transação, ~137 TPS numa wallet; ver [LOAD_TEST](docs/LOAD_TEST.md)). O `lock_timeout` limita a espera. Esgotado, vira `503`, sem segurar conexão indefinidamente.

**Por que não há deadlock.** Cada transação trava **uma** wallet, e a ordem de locks é sempre **inbox → wallet → transação**:

- o worker de referências trava a wallet e depois a transação pendente;
- duas mensagens duplicadas esperam no índice do inbox **antes** de tocar a wallet;
- portanto não há ciclo.

## 5. Schema: garantias no banco

Migration: `src/infrastructure/persistence/migrations/Migration20261106000001InitialSchema.ts`.

| Garantia | Mecanismo no PostgreSQL |
|---|---|
| valor exato, ≥ 0, escala 2, sem NaN/∞ | domínio `money_amount` (CHECK) |
| moeda ISO-4217 | domínio `currency_code` (CHECK `^[A-Z]{3}$`) |
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `money_amount` em `wallets.balance_amount`, `balance_before/after` |
| idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| no máximo um lançamento por transação e wallet | `UNIQUE (wallet_id, transaction_id)` |
| sem lost update / versões encadeadas | `UNIQUE (wallet_id, wallet_version)` + trigger de versão |
| toda alteração de saldo tem ledger | constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets` |
| lançamento aritmeticamente correto | `CHECK balance_after = balance_before ± amount` |
| ledger na moeda da wallet e ligado à transação certa | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id)` |
| ledger imutável | triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` |
| transação terminal imutável; identidade imutável; sem DELETE | trigger `guard_wager_transaction` |
| uma reversão PROCESSED por referência | índice único parcial `(reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| coerência de estado | CHECKs: `failure_code` ⇔ REJECTED/FAILED; `processed_at` ⇔ PROCESSED; saldo observado em toda decisão; agenda ⇔ PENDING_REFERENCE; `OPENING` ⇔ provider `internal`; REFUND/ROLLBACK com referência; valor > 0 (exceto LOSS) |
| dedup do consumidor | PK `(consumer_name, message_id)` no inbox |

`test/integration/schema.test.ts` viola cada garantia **direto no banco**, sem passar pela aplicação, e confere o erro. Também roda `up → down → up` num schema temporário.

## 6. Regras de negócio e máquina de estados

| Kind | Saldo | Ledger | Referência aceita |
|---|---|---|---|
| `BET` | débito | 1 DEBIT | nenhuma |
| `WIN` | crédito | 1 CREDIT | opcional: `BET` da mesma rodada |
| `LOSS` | — | nenhum | opcional: `BET` (só registra o resultado; valor pode ser `0.00`) |
| `REFUND` | crédito | 1 CREDIT | **obrigatória**: `BET` PROCESSED, mesmo valor |
| `ROLLBACK` | inverso da referência | 1 invertido | **obrigatória**: `BET` (→CREDIT), `WIN`/`REFUND` (→DEBIT), mesmo valor |
| `OPENING` | crédito | 1 CREDIT | interno, nunca aceito por API/fila |

**A referência** é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo provider, player, wallet, moeda e rodada.

**Transições:**

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (reagendada)
PROCESSED, REJECTED, FAILED: terminais (transição → InvalidTransactionStateError; no banco, trigger)
```

- `PENDING` existe só em memória: a decisão acontece na mesma transação em que a linha nasce.
- `FAILED` é usado pelo worker de referências quando um item falha com erro **não transitório** (defeito ou inconsistência). A transação fica auditável, gera o evento `WagerTransactionFailed` e não trava a fila.
- **Toda decisão grava o saldo observado** (`result_balance_amount`), e é isso que o replay devolve. Ver §8.

## 7. Taxonomia de `failureCode`

| Código | Quando | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | desistir da aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND deixaria saldo negativo | caso operacional: conciliar manualmente |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir a wallet/moeda |
| `WALLET_PLAYER_MISMATCH` | player ≠ dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite (§9) | reenviar a referência e depois nova operação |
| `REFERENCE_NOT_PROCESSED` | referência existe mas foi REJECTED/FAILED | nada a reverter |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de um WIN, ROLLBACK de LOSS | corrigir o tipo |
| `REFERENCE_MISMATCH` | outro player/wallet/moeda/rodada | corrigir o payload |
| `REVERSAL_AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial fora de escopo) | corrigir o valor |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem REFUND/ROLLBACK PROCESSED | nada a fazer (já revertida) |
| `PROCESSING_FAILED` | status `FAILED`: erro permanente de infraestrutura | investigar |

Toda rejeição é **terminal para aquela idempotency key**: reenviar devolve a mesma resposta (replay). Os erros de **contrato** (400) e de **conflito** (409) não viram transação persistida, e ficam com códigos próprios no corpo de erro (`INVALID_INPUT`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_REUSED`, `WALLET_ALREADY_EXISTS`, `WALLET_NOT_FOUND`, `TRANSIENT_FAILURE`).

## 8. Idempotência

- **Fonte da verdade: o banco.** A dedup usa `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Nenhum cache em memória participa da decisão.
  - As chaves são **escopadas por provider**. Uma key global permitiria a um provedor "ocupar" chaves de outro e receber num `409` o `transactionId` de outro provedor.
- **O header `Idempotency-Key` é obrigatório** (400 sem ele). No SQS, a key vem de `data.idempotencyKey`.
- **Fluxo, sob o lock da wallet:**
  1. busca por `(provider, key) OR (provider, externalId)` numa query só;
  2. achou com a mesma key e o mesmo hash → **replay**: devolve o resultado original, com `idempotentReplay: true` e header `Idempotent-Replayed`;
  3. achou com a mesma key e hash diferente → `409 IDEMPOTENCY_KEY_REUSED` (**nunca replay**);
  4. achou o mesmo externalId com outra key → `409 EXTERNAL_ID_REUSED`.
- **Duplicatas concorrentes** (o teste manda a mesma aposta 50x em paralelo por 3 instâncias) entram na fila do lock da wallet. A primeira commita, e as outras, já sob o lock, enxergam o commit e respondem replay. Se a mesma key chegar para **wallets diferentes**, os locks são diferentes. Nesse caso o `UNIQUE` do banco desempata: o `23505` vira retry da transação, e a releitura encontra a linha e responde conflito.
- **O replay devolve o resultado ORIGINAL**, inclusive o **saldo observado naquele momento** (`result_balance_amount`). O saldo atual não serve: se depois da aposta houve outras, o replay ainda devolve 975.00. Um `REJECTED` replayado volta `422` com o mesmo `failureCode`. `PENDING_REFERENCE` ainda não tem decisão, então devolve o estado atual.
- **`payloadHash`** = `"v1:" + sha256_hex(canonicalJson(campos))`:
  - campos: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`;
  - **JSON canônico**: chaves ordenadas recursivamente, sem espaços, `undefined` omitido (ausente ≡ undefined) e `number` **proibido** (todo campo de negócio é string, então a serialização não depende de formatação de float);
  - UUIDs são normalizados para minúsculas **antes** do hash;
  - **não entram:** o header `Idempotency-Key`, o `messageId`, `occurredAt` e qualquer metadado de transporte;
  - o prefixo `v1:` permite trocar o algoritmo sem ambiguidade.

## 9. Referências fora de ordem

- **Referência ausente:** a transação é persistida como `PENDING_REFERENCE` e responde `202`. Também emite o evento `WagerTransactionPendingReference`, só na entrada em pendência.
- **Worker agendado (`PendingReferenceWorker`):**
  - a cada `PENDING_REF_POLL_MS`, lê candidatos vencidos sem lock;
  - processa cada um numa transação própria: lock da wallet → lock da transação → reconfere o status → aplica **o mesmo** `WagerSettlementService` do caminho online;
  - seguro com N instâncias: quem chega depois vê o status já alterado e pula.
- **"Acordar dependentes".** Quando uma transação é PROCESSED, a mesma transação SQL antecipa (`next_reference_attempt_at = now()`) as pendentes que esperavam por ela. Na prática, o ROLLBACK que chegou antes do BET é aplicado no próximo ciclo do worker, e não no fim do backoff.
- **Backoff exponencial:** `min(60 s, 1 s × 2^tentativa)`, no máximo **10 tentativas** (~5 minutos no total).
  - **Por quê:** provedores costumam reenviar a operação original em segundos ou poucos minutos, e com 5 minutos sobra margem para isso.
  - Um TTL mais longo deixaria uma reversão "suspensa" por muito tempo, sem decisão para o provedor.
  - Ao esgotar: `REJECTED REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
  - Os valores são configuráveis por env.
- **Referência que também está pendente** (ROLLBACK de um REFUND que espera o BET): continua aguardando.

## 10. SQS: consumidor, inbox, retry e DLQ

Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` (saída da outbox).

- **Mesmo caso de uso do HTTP** (`SubmitWagerTransaction`), com o mesmo parse/validação de contrato.
- **Inbox persistente `(consumerName, messageId)`, na MESMA transação do efeito.** O `messageId` é o do envelope do produtor, não o id interno do SQS.
  - É gravado com `INSERT … ON CONFLICT DO NOTHING`.
  - Se uma duplicata chega durante o processamento da original, o INSERT **espera** o desfecho dela: commit → duplicata; rollback → processa.
  - Se a linha existe, o efeito existe, porque os dois commitam juntos.
  - O mesmo `messageId` com corpo diferente é conflito e vai para a DLQ.
- **Ack (`DeleteMessage`) somente depois do commit.**
- **Classificação:**

  | Caso | Ação |
  |---|---|
  | PROCESSED / REJECTED / PENDING_REFERENCE / duplicata | **ack** (decisão terminal de negócio) |
  | transitório (lock timeout, deadlock, banco fora, erro inesperado) | `ChangeMessageVisibility` com backoff `min(60 s, 2 s × 2^(n−1))` |
  | permanente (JSON/envelope/contrato inválido, wallet inexistente, conflito de idempotência ou de inbox) | **DLQ imediata** com atributos `failureReason`, `failureDetail`, `receiveCount`; depois ack |
  | transitório na tentativa `maxReceiveCount` (5) | DLQ com `RETRIES_EXHAUSTED` (pode voltar por redrive) |

  A fila também tem `RedrivePolicy` (`maxReceiveCount + 1`) como **rede de segurança do broker**, para uma mensagem que derrube o processo em loop.
- **Ordem e paralelismo:**
  - mensagens do mesmo `MessageGroupId` (wallet) num receive rodam em sequência; grupos diferentes rodam em paralelo;
  - **o FIFO é otimização:** a correção vem do lock e do inbox no banco. Os testes mandam duplicatas com dedup ids diferentes justamente para burlar a dedup do broker.
- **Morte depois do commit e antes do ack** (testado com SIGKILL real): a mensagem volta após o visibility timeout, o inbox detecta a duplicata e o ack acontece sem efeito novo.
- **SIGTERM:** o consumidor para de receber (aborta o long poll), termina as mensagens em andamento e devolve `visibility = 0` às recebidas que não começaram. O publisher devolve as leases. Depois o pool fecha. Um timer de `SHUTDOWN_GRACE_MS` força a saída se algo travar.

## 11. Transactional outbox e eventos

- **O evento é gravado na mesma transação** do efeito financeiro. Nada é publicado antes do commit, e nenhuma chamada de rede acontece com a transação aberta.
- **Publisher (`OutboxPublisher`, um por instância):**
  1. **claim com lease:** `UPDATE … SET locked_by, locked_until FROM (SELECT … FOR UPDATE SKIP LOCKED ORDER BY seq LIMIT n)`. Publishers concorrentes pegam lotes **disjuntos** sem esperar uns pelos outros;
  2. **publica fora de transação** com `SendMessageBatch`, em lotes de até 10 que misturam wallets;
  3. marca `published_at` em lote. Só quem detém a lease marca.
- **Falha no envio:** `scheduleRetry` com backoff exponencial limitado + jitter. A outbox **nunca desiste**, porque perder evento confirmado é proibido; o que cresce é o lag, e ele é exposto como métrica.
- **Crash:**
  - morreu entre o claim e o publish: a lease expira e outra instância publica (testado com SIGKILL);
  - morreu entre o publish e o mark: outra instância **republica**. É **at-least-once**, por isso o `eventId` vai como `MessageDeduplicationId` (dedup do broker por 5 minutos, uma otimização) e no envelope, para o consumidor deduplicar (a garantia).
- **Ordem por wallet:**
  - `MessageGroupId = walletId`;
  - o lote é particionado por hash(walletId) em `OUTBOX_PARALLELISM` partições, e cada wallet sempre cai na mesma partição, que publica em sequência na ordem de `seq`;
  - se um evento de uma wallet falha, os seguintes **daquela wallet** são adiados, para não marcar como publicado um evento "por cima" de um buraco;
  - `seq` reflete a ordem de commit **por wallet**, porque o lock serializa as transações da wallet;
  - entre publishers diferentes, a ordem é best-effort. Os eventos carregam `walletVersion` para o consumidor ordenar ou descartar eventos obsoletos.
- **Envelope:** classe abstrata `IntegrationEvent<T>`, com `eventType` e `version` **no tipo** de cada subclasse:
  - `WagerTransactionProcessed`: inclusive LOSS e OPENING;
  - `WagerTransactionRejected`;
  - `WalletBalanceChanged`: só quando o saldo muda;
  - `WagerTransactionPendingReference`;
  - `WagerTransactionFailed` (extra).

  O campo `data` carrega `MoneyProps` (strings), nunca uma instância de `Money`.

## 12. Reconciliação

`POST /wallets/:id/reconciliation` lê wallet e ledger no **mesmo snapshot** (`REPEATABLE READ READ ONLY`), sem pegar o lock da wallet, então não compete com o tráfego de uma hot wallet. A soma assinada é calculada pelo PostgreSQL em `NUMERIC`.

Verificações:

- saldo materializado == soma do ledger;
- versões do ledger contíguas;
- última versão == `wallet.version`.

A divergência **não é corrigida**. Ela é logada em `error`, contada em `wagering_reconciliation_mismatches_total` e devolvida com `consistent: false`, `difference` e `checks`. A mesma função é a invariante final de todos os testes.

## 13. Observabilidade

- **Logs JSON (pino).** Um `AsyncLocalStorage` propaga `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, que entram em toda linha emitida dentro da requisição ou mensagem. O `X-Correlation-Id` é aceito no request e devolvido na resposta.
  - **Sem payload financeiro nos logs.** Nenhum log inclui body ou valores, e `redact` serve de rede de segurança. Um teste confere isso.
- **Métricas (`GET /metrics`, Prometheus):**

  | Métrica | O que mede |
  |---|---|
  | `wagering_transactions_total{kind,status,channel}` | transações por status |
  | `wagering_duplicates_detected_total{source=idempotency\|inbox}` | duplicatas detectadas |
  | `wagering_retries_total{operation,reason}` | retries |
  | `wagering_dlq_messages_total{reason}` | mensagens na DLQ |
  | `wagering_lock_conflicts_total{reason}` | conflitos de lock |
  | `wagering_outbox_pending_messages` e `wagering_outbox_lag_seconds` | outbox lag |
  | `wagering_processing_duration_seconds{channel}` (histograma) | latência de processamento |
  | `wagering_reconciliation_mismatches_total` | divergências da reconciliação |

  Também há as métricas default do processo.
- **Health:**
  - `/health/live`: o processo responde;
  - `/health/ready`: `SELECT 1` no PostgreSQL e `GetQueueAttributes` no SQS, com timeout de 2 s cada; `503` se algum falhar;
  - os dois são públicos (`@Public`).

## 14. Autenticação

**Decisão: não implementada.** Ela vale 0 pontos e competiria por tempo com correção, concorrência e idempotência. O **ponto de extensão está no código** (`src/interfaces/http/auth.guard.ts`):

- **Porta `ProviderIdentityPort`.** A implementação atual (`AllowAllProviderIdentity`) é explícita: todo chamador é confiável.
- **`ProviderAuthGuard` global** (`APP_GUARD`). Rotas `@Public()` (health, métricas) passam direto.

**Desenho que seria adotado:**

1. **Keycloak** (OIDC) no compose, com um *confidential client* por provedor e o fluxo `client_credentials`.
2. O token traz a claim `provider_id` (via mapper).
3. Uma implementação `JwtProviderIdentity` valida assinatura, `iss`, `aud` e `exp` via JWKS (lib `jose`, com cache de chaves). Depois o guard exige `body.providerId == claim` (ou `:providerId` na rota). Divergência → `403`.
4. A fila continua sendo canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio: formato, provider `internal` reservado e referência do mesmo provider.

Trocar a implementação é um provider no módulo do Nest. Nenhum caso de uso muda.

## 15. Interpretações do enunciado

- **"Não pode ser revertida duas vezes pelo mesmo tipo de operação"** foi interpretada de forma **mais estrita**: uma transação pode ser alvo de **uma** reversão PROCESSED, seja REFUND ou ROLLBACK.
  - **Por quê:** REFUND **e** ROLLBACK do mesmo BET creditariam o jogador duas vezes.
  - Reverter a própria reversão continua permitido (ROLLBACK de um REFUND), porque o alvo é outra transação.
  - É garantido por índice único parcial.
- **WIN e LOSS** podem referenciar opcionalmente o BET da rodada. Se informada, a referência passa pelas mesmas validações; se ausente, entra em `PENDING_REFERENCE`.
- **Valor:** LOSS aceita `0.00`; os demais kinds exigem valor > 0.
- **Wallet inexistente** é erro permanente (`404` / DLQ), e não `PENDING_REFERENCE`. Não existe linha de wallet para travar, e a transação teria FK para nada.
- **Player diferente do dono da wallet** é rejeição de negócio persistida (`WALLET_PLAYER_MISMATCH`), porque a wallet existe e a decisão precisa ser auditável.
- **Status HTTP:**
  - `201` para processada na primeira vez e `200` para replay de processada;
  - `422` para rejeição, na primeira vez e no replay;
  - `202` para pendente.
- **`OPENING`** usa o provider reservado `internal` (uma CHECK amarra os dois) e emite `WagerTransactionProcessed` + `WalletBalanceChanged`.
- **A reconciliação é `POST`** (como no enunciado) por ser uma ação de auditoria, mas é somente leitura.

## 16. Trade-offs e limitações

- **Teto de uma hot wallet:** ~137 TPS medidos em notebook. Aumentar exigiria particionar o saldo (sub-wallets) ou encurtar a seção crítica, o que muda o modelo. É uma decisão consciente: correção primeiro.
- **O outbox lag sob carga é dominado pelo MiniStack** (~100 msgs/s medidos). O desenho com lotes de 10 e partições paralelas não foi medido contra o SQS real. Ver [LOAD_TEST](docs/LOAD_TEST.md).
- **Ordem global de eventos entre publishers** é best-effort. A ordem por wallet é garantida dentro de um publisher, e `walletVersion` permite ao consumidor reordenar.
- **Não há retenção/expurgo** de `outbox_messages` publicadas nem de `inbox_messages`. Em produção: job de limpeza com janela maior que o maior redelivery possível, ou particionamento por data.
- **Visibilidade do SQS:** não há heartbeat. O processamento é curto (lock timeout de 2 s × 4 tentativas, bem abaixo dos 30 s de visibilidade). Se o processamento passar do timeout, a mensagem reaparece e o inbox absorve a duplicata.
- **Autenticação** não implementada (§14).
- **Sem OpenTelemetry/dashboard**, que são opcionais. O `correlationId` já permite rastrear entre logs.
- **Ledger simples, sem partidas dobradas:** partidas dobradas são diferencial opcional. O ledger é por wallet, append-only, com `balance_before/after` e versão encadeada, o que basta para auditoria e reconciliação.
