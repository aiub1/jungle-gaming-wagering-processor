import DecimalJs from 'decimal.js';
import { CurrencyMismatchError, InvalidInputError } from './errors';

/**
 * Clone isolado do decimal.js: a configuração global da lib nunca é tocada.
 * Precisão de 40 dígitos significativos é muito acima do que o schema aceita
 * (18 inteiros + 2 decimais), então soma e subtração são sempre exatas —
 * o domínio nunca divide nem multiplica, logo nunca arredonda.
 */
const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

/** DTO de fronteira: valor como string decimal, nunca `number`. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;
/** Cabe em `numeric` com até 18 dígitos inteiros (limite do domínio SQL `money_amount`). */
const MAX_INTEGER_DIGITS = 18;
/**
 * Formato estrito de entrada: dígitos, ponto, exatamente 2 casas.
 * Rejeita: sinal, notação científica, NaN/Infinity, espaços, zeros à esquerda,
 * "1.", ".5", "1.5" (escala diferente de 2) e "1.005" (mais de 2 casas).
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${MONEY_SCALE}}$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Factory de contrato de entrada (HTTP, SQS, banco). Não aceita valores
   * negativos nem qualquer formato ambíguo. Não existe política de
   * arredondamento: entrada fora da escala é rejeitada, nunca ajustada.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidInputError('money must be an object { amount, currency }', 'money');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidInputError('amount must be a decimal string (e.g. "25.00")', 'money.amount');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidInputError(
        `amount must be a non-negative decimal string with exactly ${MONEY_SCALE} decimal places`,
        'money.amount',
      );
    }
    return new Money(new Decimal(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Sempre escala fixa de 2 casas: "25.00", "-3.10", "0.00". */
  get amount(): string {
    // toFixed do decimal.js opera em base decimal (não é Number#toFixed) e,
    // como todo valor nasce com no máximo 2 casas, nunca precisa arredondar.
    const fixed = this.value.toFixed(MONEY_SCALE);
    return fixed === '-0.00' ? '0.00' : fixed;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidInputError('currency must be an ISO-4217 code (e.g. "BRL")', 'money.currency');
    }
    return currency;
  }
}
