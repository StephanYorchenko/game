/** Исполнитель получает уже подготовленную копию эффекта, не локальный стек. */
export interface QueuedEffect<Operation> {
  readonly ownerId: string;
  readonly source: "ordinary" | "death";
  readonly operations: readonly Operation[];
}

export interface EffectExecution<
  Operation,
  Effect extends QueuedEffect<Operation> = QueuedEffect<Operation>,
> {
  readonly effect: Effect;
  /** Последствия ждут завершения всех операций текущего эффекта. */
  emit(...effects: readonly Effect[]): void;
}

export interface ExecutionHooks<
  Operation,
  Effect extends QueuedEffect<Operation> = QueuedEffect<Operation>,
> {
  isOwnerAlive(ownerId: string): boolean;
  canExecute(operation: Operation, context: EffectExecution<Operation, Effect>): boolean;
  execute(operation: Operation, context: EffectExecution<Operation, Effect>): void;
  /** Точка интеграции проверки смерти: после операций, до следующего элемента. */
  afterEffect?(context: EffectExecution<Operation, Effect>): void;
}

/** Синхронная очередь: атомарность для планировщика, без отката операций. */
export class ExecutionQueue<
  Operation,
  Effect extends QueuedEffect<Operation> = QueuedEffect<Operation>,
> {
  private pending: Effect[] = [];
  private running = false;
  private failed = false;

  constructor(private readonly hooks: ExecutionHooks<Operation, Effect>) {}

  get size(): number {
    return this.pending.length;
  }

  /** Первоначальная очередь. Внутри эффекта используется только context.emit. */
  enqueue(...effects: readonly Effect[]): void {
    if (this.running || this.failed) {
      throw new Error("Нельзя дополнять очередь во время исполнения или после ошибки");
    }

    this.pending.push(...effects.map((effect) => this.copy(effect)));
  }

  drain(): void {
    if (this.running || this.failed) {
      throw new Error("Повторный вход или продолжение очереди после ошибки запрещены");
    }

    this.running = true;

    try {
      while (this.pending.length > 0) {
        const effect = this.pending.shift()!;

        if (effect.source !== "death" && !this.hooks.isOwnerAlive(effect.ownerId)) {
          continue;
        }

        const consequences: Effect[] = [];
        let active = true;
        const context: EffectExecution<Operation, Effect> = {
          effect,
          emit: (...effects) => {
            if (!active) {
              throw new Error("Контекст завершившегося эффекта больше не принимает последствия");
            }

            consequences.push(...effects.map((consequence) => this.copy(consequence)));
          },
        };

        try {
          for (const operation of effect.operations) {
            if (this.hooks.canExecute(operation, context)) {
              this.hooks.execute(operation, context);
            }
          }

          this.hooks.afterEffect?.(context);
        } finally {
          active = false;
        }

        this.pending = [...consequences, ...this.pending];
      }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.running = false;
    }
  }

  private copy(effect: Effect): Effect {
    return { ...effect, operations: [...effect.operations] };
  }
}
