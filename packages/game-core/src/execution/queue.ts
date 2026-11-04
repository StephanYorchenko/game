export interface EntryExecution<Entry> {
  readonly entry: Entry;
  emit(...entries: readonly Entry[]): void;
}

export interface EntryHooks<Entry> {
  copy(entry: Entry): Entry;
  canExecute(entry: Entry): boolean;
  execute(entry: Entry, context: EntryExecution<Entry>): void;
}

/** Общий планировщик атомарных эффектов и независимых событий. */
export class EntryQueue<Entry> {
  private pending: Entry[] = [];
  private running = false;
  private failed = false;

  constructor(private readonly hooks: EntryHooks<Entry>) {}

  get size(): number {
    return this.pending.length;
  }

  enqueue(...entries: readonly Entry[]): void {
    if (this.running || this.failed) {
      throw new Error("Нельзя дополнять очередь во время исполнения или после ошибки");
    }

    this.pending.push(...entries.map((entry) => this.hooks.copy(entry)));
  }

  drain(): void {
    if (this.running || this.failed) {
      throw new Error("Повторный вход или продолжение очереди после ошибки запрещены");
    }

    this.running = true;

    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;

        if (!this.hooks.canExecute(entry)) {
          continue;
        }

        const consequences: Entry[] = [];
        let active = true;
        const context: EntryExecution<Entry> = {
          entry,
          emit: (...entries) => {
            if (!active) {
              throw new Error("Контекст завершившегося эффекта больше не принимает последствия");
            }

            consequences.push(...entries.map((consequence) => this.hooks.copy(consequence)));
          },
        };

        try {
          this.hooks.execute(entry, context);
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
}
