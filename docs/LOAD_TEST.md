# Teste de carga

`bun run test:load` · código em [`test/load/run.ts`](../test/load/run.ts) · saída bruta em `test/load/results/latest.json` (não versionada).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | notebook Intel Core i5-8265U (4 núcleos / 8 threads, 1.6 GHz), 8 GB RAM |
| Runtime | Bun 1.4.4 |
| Instâncias | 3 processos `bun src/main.ts` (`APP_ROLE=all`: HTTP + consumer + publisher + worker) |
| Banco | PostgreSQL 18.6 (Docker, mesma máquina), `max_connections=300`, pool de 20 por instância |
| SQS | MiniStack 1.5.38 (Docker, mesma máquina) |
| Gerador | mesmo host, 32 clientes HTTP em loop fechado, 20 s por cenário |

Tudo divide a mesma CPU de notebook: os números servem para **comparar cenários e achar gargalos**, não para estimar capacidade de produção.

## Metodologia

- **Closed-loop:** cada cliente só manda a próxima requisição quando recebe a resposta, distribuindo entre as 3 instâncias em round-robin. A vazão é a que o sistema aguenta com 32 requisições em voo, não uma taxa imposta.
- **Cenários:**
  - **A**: 200 wallets, `BET`/`WIN` aleatórios de `1.00`. Contenção baixa.
  - **B**: hot wallet, todas as requisições na mesma wallet. É o pior caso do lock pessimista.
  - **C**: igual a A, mas 30% das requisições repetem uma `Idempotency-Key` já enviada (replays).
- **Antes dos cenários:** o teto do emulador SQS é medido com `SendMessageBatch` em 8 chamadas paralelas.
- **Coleta:**
  - latência no cliente (p50/p95/p99/max);
  - status HTTP;
  - `wagering_lock_conflicts_total` e `wagering_retries_total`, lidos do `/metrics` das 3 instâncias;
  - outbox lag (idade do evento pendente mais antigo), amostrado a cada 250 ms.
- **Verificação final:** reconciliação de **todas** as wallets tocadas.

## Resultados (execução de 2026-11-06)

| Cenário | Req. | Vazão (req/s) | p50 | p95 | p99 | max | Erros | Lock conflicts | Retries | Lag máx. outbox | Wallets consistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A: 200 wallets | 9 860 | **493** | 61 ms | 106 ms | 154 ms | 417 ms | 0% | 0 | 0 | 47 s | 200/200 |
| B: hot wallet | 2 735 | **137** | 226 ms | 313 ms | 495 ms | 665 ms | 0% | 0 | 0 | 92 s | 1/1 |
| C: A + 30% replays | 12 845 | **642** | 48 ms | 86 ms | 113 ms | 354 ms | 0% | 0 | 0 | 137 s | 200/200 |

Teto medido do MiniStack: **~96 a 137 mensagens/s** (varia por execução; não sobe com mais paralelismo).

## Análise

1. **Correção sob carga.** Foram 25 mil requisições, com 0 erros e 0 inconsistências. Todo replay devolveu `200` com o resultado original. O lock da wallet nunca estourou `lock_timeout` (2 s), então nada virou `503`.

2. **A hot wallet é limitada pelo lock, como esperado.** Com lock pessimista por wallet, as transações de uma mesma wallet são serializadas. A vazão de ~137 TPS dá ~7 ms por transação: a transação inteira, incluindo inbox, ledger, outbox e commit, segura o lock. A latência sobe porque 32 clientes esperam na fila do mesmo `FOR UPDATE`, não porque algo falhou. Para ir além disso seria preciso encurtar a seção crítica, por exemplo com saldo particionado em sub-wallets, o que muda o modelo. Wallets diferentes não competem entre si.

3. **Replays são mais baratos** (cenário C, p50 de 48 ms contra 61 ms). O replay ainda pega o lock, porque a decisão é tomada sob o lock por segurança, mas não escreve ledger nem outbox.

4. **O outbox lag é limitado pelo emulador, não pelo desenho.** A carga gera ~1 000 a 1 300 eventos/s (2 por transação que muda saldo), e o MiniStack aceita ~100 msgs/s. O lag cresce de forma linear com o backlog e se acumula entre cenários. Antes dessa medição o publisher mandava um evento por chamada e montava lotes só por wallet, então com 200 wallets cada lote tinha 1 evento. Ele passou a usar `SendMessageBatch` com 10 eventos misturando wallets, em 8 partições por hash da wallet (a ordem por wallet continua garantida). Mesmo assim o teto do emulador domina. No SQS real, que aceita milhares de msgs/s por fila, o gargalo seria outro. Isso **não foi medido** aqui.

5. **O que este teste não mostra:**
   - comportamento com o PostgreSQL saturado de conexões;
   - a rede real entre AZs;
   - o SQS real;
   - execuções longas (vazamento de memória, autovacuum, crescimento da outbox sem limpeza).

   A outbox publicada não é expurgada; numa operação real seria preciso um job de retenção ou particionamento por data.
