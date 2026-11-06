# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por **HTTP** e **SQS**, e continua correto com mensagens **duplicadas**, **fora de ordem** e **simultâneas**, com **várias instâncias** no ar.

- Enunciado original: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Teste de carga (metodologia e resultados): [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md)

**Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · AWS SQS (MiniStack) · Docker Compose

---

## Pré-requisitos

- Docker com Compose v2
- Bun ≥ 1.4 (só para rodar testes/CLIs fora do Docker): `curl -fsSL https://bun.sh/install | bash`

## Subir tudo (3 instâncias)

```bash
docker compose up -d --build --wait
```

Sobe PostgreSQL, MiniStack (SQS), um job `bootstrap` (migrations + criação das filas) e **3 instâncias** idênticas da aplicação (`app-1..3` → portas `3001..3003`), cada uma com API HTTP, consumidor SQS, publisher da outbox e worker de referências pendentes.

```bash
curl -s localhost:3001/health/ready
```

Para derrubar e apagar os dados:

```bash
docker compose down -v
```

## Exemplo rápido

```bash
# 1) cria a wallet (instância 1)
curl -s -XPOST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
# 2) aposta pela instância 2 (troque WALLET_ID). Repetir o comando devolve o MESMO resultado com idempotentReplay=true
curl -s -XPOST localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```bash
# 3) WIN pela fila SQS — rode 3x com o mesmo messageId: o inbox garante um único crédito
bun src/cli/send-wager-message.ts WALLET_ID 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1 WIN 50.00 transaction-123 msg-demo-1
```

```bash
# 4) consulta e reconciliação (instância 3)
curl -s localhost:3003/wallets/WALLET_ID
curl -s -XPOST localhost:3003/wallets/WALLET_ID/reconciliation
```

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial > 0 gera `OPENING` + ledger na mesma transação) |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado, cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | saldo materializado × saldo reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | transação por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação por id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + SQS), sem autenticação |
| `GET` | `/metrics` | métricas Prometheus |

**Status HTTP (iguais em todos os endpoints):**

| Situação | Status | Pode reenviar? |
|---|---|---|
| processada (primeira vez) | `201` | — |
| replay idêntico | `200` + `Idempotent-Replayed: true` | — |
| aceita, aguardando referência (`PENDING_REFERENCE`) | `202` | sim (replay) |
| payload inválido | `400 INVALID_INPUT` | não; corrigir |
| recurso inexistente | `404 *_NOT_FOUND` | não |
| conflito de idempotência / wallet duplicada | `409` | não; não é replay |
| rejeição de negócio (`REJECTED` + `failureCode`) | `422` | não; decisão terminal |
| falha transitória de infraestrutura | `503` + `Retry-After` | **sim, a mesma requisição** |

Taxonomia de `failureCode` e contrato da fila: [`ARCHITECTURE.md`](ARCHITECTURE.md#7-taxonomia-de-failurecode).

## Testes

Os testes de integração e concorrência usam **PostgreSQL e SQS reais** (containers). Eles rodam num banco (`wagering_test`) e em filas (`test-*`) separados, sem interferir na stack do compose.

```bash
bun install
bun run infra:up          # só postgres + sqs
bun run test              # tudo: unit + integração + concorrência (~35 s)
```

```bash
bun run test:unit         # domínio puro, sem infraestrutura
bun run test:integration  # schema/constraints, atomicidade, inbox, DLQ, outbox, HTTP
bun run test:concurrency  # 3 processos reais, crashes com SIGKILL, restart
bun run typecheck
```

| Exigência (seção 13) | Onde |
|---|---|
| Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, moeda, payload divergente | `test/unit/*` |
| migrations e constraints | `test/integration/schema.test.ts` |
| atomicidade, inbox/redelivery, retry/DLQ | `test/integration/atomicity-and-messaging.test.ts` |
| publishers concorrentes, recuperação após restart, referências fora de ordem | `test/integration/outbox-and-recovery.test.ts` |
| contrato HTTP, logs, health, métricas | `test/integration/http-api.test.ts` |
| 50x mesma aposta, 2×80 em 100, wallets em paralelo, 3 instâncias, duplicatas SQS | `test/concurrency/multi-instance.test.ts` |
| worker morto pós-commit/pré-ack, publisher morto, SIGTERM, restart sob carga | `test/concurrency/crash-recovery.test.ts` |

Toda verificação termina na invariante `wallet.balance == saldo reconstruído pelo ledger` (`assertWalletConsistent`).

### Teste de carga

```bash
bun run test:load         # LOAD_DURATION_S=15 LOAD_CLIENTS=32 por padrão
```

Resultados e análise em [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

## Rodar fora do Docker

```bash
cp .env.example .env
bun run infra:up && bun run migrate:up && bun run queues:setup
bun run start             # APP_ROLE=all; use start:api / start:worker para separar papéis
```

Migrations: `bun run migrate:up` / `bun run migrate:down` (reversíveis).

## Estrutura

```
src/
  domain/           Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, WagerSettlement (regras puras)
  application/      casos de uso (SubmitWagerTransaction, OpenWallet, ProcessPendingReferences, Reconcile, queries) e portas
  infrastructure/   MikroORM/PostgreSQL (UoW, repositórios SQL, migration), SQS (consumer, publisher), observabilidade, workers
  interfaces/http/  controllers NestJS, filtro de erros, guard de autenticação (ponto de extensão)
  composition.ts    composition root (um único wiring para app e testes)
  main.ts           entrypoint; APP_ROLE = api | worker | all
test/               unit · integration · concurrency · load
```
