import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras vivem AQUI, não só no código:
 *
 *  - dinheiro: domínio `money_amount` (numeric sem precisão declarada + CHECK de
 *    escala = 2, ≥ 0, ≠ NaN, < 10^18). Sem `numeric(p,2)` de propósito: ele
 *    ARREDONDARIA 10.005 em silêncio antes do CHECK; aqui a escrita é recusada.
 *  - unicidade: wallet por (player, moeda); idempotência por (provider, key) e
 *    (provider, external_id); um lançamento por (wallet, transação); uma versão
 *    por (wallet, wallet_version) — lost update vira violação de schema;
 *    uma reversão PROCESSED por referência (índice único parcial).
 *  - imutabilidade: ledger rejeita UPDATE/DELETE/TRUNCATE; transação terminal
 *    não muda; colunas de identidade da transação nunca mudam.
 *  - não-negatividade: CHECK no saldo e nos saldos do ledger.
 *  - consistência saldo ↔ ledger: constraint trigger DEFERRED verifica, no
 *    COMMIT, que a versão atual da wallet tem lançamento com balance_after igual
 *    ao saldo; e que version só muda (+1) quando o saldo muda.
 */
export class Migration20261106000001InitialSchema extends Migration {
  override name = 'Migration20261106000001InitialSchema';

  override async up(): Promise<void> {
    this.addSql(`
      CREATE DOMAIN money_amount AS numeric
        CONSTRAINT money_amount_valid CHECK (
          VALUE <> 'NaN'::numeric AND VALUE >= 0 AND scale(VALUE) = 2 AND VALUE < 1000000000000000000
        );
      CREATE DOMAIN currency_code AS text
        CONSTRAINT currency_code_iso4217 CHECK (VALUE ~ '^[A-Z]{3}$');
    `);

    this.addSql(`
      CREATE TABLE wallets (
        id              uuid PRIMARY KEY,
        player_id       text NOT NULL,
        currency        currency_code NOT NULL,
        balance_amount  money_amount NOT NULL,
        version         integer NOT NULL CONSTRAINT wallets_version_positive CHECK (version >= 1),
        created_at      timestamptz NOT NULL,
        updated_at      timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- alvo das FKs compostas: garante que o ledger está na moeda da wallet
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid PRIMARY KEY,
        provider_id                        text NOT NULL,
        external_transaction_id            text NOT NULL,
        idempotency_key                    text NOT NULL,
        payload_hash                       text NOT NULL,
        wallet_id                          uuid NOT NULL REFERENCES wallets (id),
        player_id                          text NOT NULL,
        round_id                           text NOT NULL,
        game_id                            text NOT NULL,
        kind                               text NOT NULL,
        amount                             money_amount NOT NULL,
        currency                           currency_code NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid REFERENCES wager_transactions (id),
        status                             text NOT NULL,
        failure_code                       text,
        result_balance_amount              money_amount,
        reference_attempts                 integer NOT NULL DEFAULT 0,
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz NOT NULL,
        updated_at                         timestamptz NOT NULL,
        processed_at                       timestamptz,

        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_id_wallet_uq UNIQUE (id, wallet_id),

        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_failure_iff_rejected_or_failed CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_at_iff_processed CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_result_balance_on_decision CHECK (status NOT IN ('PROCESSED','REJECTED') OR result_balance_amount IS NOT NULL),
        CONSTRAINT wager_tx_reversal_requires_reference CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_only_when_processed CHECK (reference_transaction_id IS NULL OR status = 'PROCESSED'),
        CONSTRAINT wager_tx_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_tx_pending_reference_schedule CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT wager_tx_attempts_non_negative CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_positive_amount CHECK (kind = 'LOSS' OR amount > 0)
      );

      -- Uma referência só pode ser revertida UMA vez (REFUND ou ROLLBACK, somados):
      -- REFUND + ROLLBACK do mesmo BET creditaria duas vezes.
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

      -- Worker de referências pendentes
      CREATE INDEX wager_tx_pending_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';

      -- "Acordar" dependentes quando a referência chega
      CREATE INDEX wager_tx_pending_by_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid PRIMARY KEY,
        wallet_id       uuid NOT NULL,
        transaction_id  uuid NOT NULL,
        wallet_version  integer NOT NULL CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
        direction       text NOT NULL CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        amount          money_amount NOT NULL CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        currency        currency_code NOT NULL,
        balance_before  money_amount NOT NULL,
        balance_after   money_amount NOT NULL,
        created_at      timestamptz NOT NULL,

        CONSTRAINT ledger_one_entry_per_tx_wallet_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_entry_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text NOT NULL,
        message_id     text NOT NULL,
        payload_hash   text NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid PRIMARY KEY,
        -- seq: ordem de inserção. Como cada wallet é serializada pelo lock, a
        -- ordem de seq dentro de um group_key é a ordem de commit daquela wallet.
        seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id     text NOT NULL,
        group_key        text NOT NULL,
        event_type       text NOT NULL,
        payload          jsonb NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer NOT NULL DEFAULT 0 CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        next_attempt_at  timestamptz NOT NULL,
        published_at     timestamptz,
        locked_by        text,
        locked_until     timestamptz,
        last_error       text
      );
      CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, seq) WHERE published_at IS NULL;
    `);

    // ---------------------------------------------------------------- triggers
    this.addSql(`
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$;

      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
    `);

    this.addSql(`
      CREATE FUNCTION guard_wager_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'immutable columns of wager transaction % cannot change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;

      CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction();
    `);

    this.addSql(`
      -- version só muda quando o saldo muda, e sempre em +1.
      CREATE FUNCTION guard_wallet_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'immutable columns of wallet % cannot change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance_amount IS DISTINCT FROM OLD.balance_amount THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet % balance change must increment version by 1', OLD.id USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version can only change with the balance', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;

      CREATE TRIGGER wallets_version_guard BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_version();

      -- No COMMIT: a versão atual da wallet tem de ter um lançamento cujo
      -- balance_after é o saldo materializado (toda alteração de saldo tem ledger).
      -- Exceção: wallet aberta com saldo zero (version 1, sem lançamento).
      CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        w wallets%ROWTYPE;
        entry_after numeric;
      BEGIN
        SELECT * INTO w FROM wallets WHERE id = NEW.id;
        SELECT balance_after INTO entry_after
          FROM wallet_ledger_entries WHERE wallet_id = w.id AND wallet_version = w.version;
        IF entry_after IS NULL THEN
          IF w.version = 1 AND w.balance_amount = 0 THEN
            RETURN NULL;
          END IF;
          RAISE EXCEPTION 'wallet % version % has no ledger entry', w.id, w.version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF entry_after <> w.balance_amount THEN
          RAISE EXCEPTION 'wallet % balance % differs from ledger %', w.id, w.balance_amount, entry_after
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$;

      CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
      DROP FUNCTION IF EXISTS assert_wallet_matches_ledger();
      DROP FUNCTION IF EXISTS guard_wallet_version();
      DROP FUNCTION IF EXISTS guard_wager_transaction();
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
      DROP DOMAIN IF EXISTS currency_code;
      DROP DOMAIN IF EXISTS money_amount;
    `);
  }
}
