/** Исполнитель получает уже подготовленную копию эффекта, не локальный стек. */
export interface QueuedEffect<Operation> {
  readonly ownerId: string;
  readonly source: "ordinary" | "death";
  readonly operations: readonly Operation[];
}

export interface EffectExecution<Operation> {
  readonly effect: QueuedEffect<Operation>;
  /** Последствия ждут завершения всех операций текущего эффекта. */
  emit(...effects: readonly QueuedEffect<Operation>[]): void;
}

export interface ExecutionHooks<Operation> {
  isOwnerAlive(ownerId: string): boolean;
  canExecute(operation: Operation, context: EffectExecution<Operation>): boolean;
  execute(operation: Operation, context: EffectExecution<Operation>): void;
  /** Точка интеграции проверки смерти: после операций, до следующего элемента. */
  afterEffect?(context: EffectExecution<Operation>): void;
}

/** Синхронная очередь: атомарность для планировщика, без отката операций. */
export class ExecutionQueue<Operation> {
  private pending: QueuedEffect<Operation>[] = [];
  private running = false;
  private failed = false;

  constructor(private readonly hooks: ExecutionHooks<Operation>) {}

  get size(): number {
    return this.pending.length;
  }

  /** Первоначальная очередь. Внутри эффекта используется только context.emit. */
  enqueue(...effects: readonly QueuedEffect<Operation>[]): void {
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

        const consequences: QueuedEffect<Operation>[] = [];
        let active = true;
        const context: EffectExecution<Operation> = {
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

  private copy(effect: QueuedEffect<Operation>): QueuedEffect<Operation> {
    return { ...effect, operations: [...effect.operations] };
  }
}
