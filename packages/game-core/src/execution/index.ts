import { EntryQueue } from "./queue";
export { EntryQueue } from "./queue";
export type { EntryExecution, EntryHooks, EntryObserver } from "./queue";

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
  emit(...effects: readonly Effect[]): void;
}

export interface ExecutionHooks<
  Operation,
  Effect extends QueuedEffect<Operation> = QueuedEffect<Operation>,
> {
  copyEffect?(effect: Effect): Effect;
  canExecuteEffect?(effect: Effect): boolean;
  isOwnerAlive(ownerId: string): boolean;
  canExecute(operation: Operation, context: EffectExecution<Operation, Effect>): boolean;
  execute(operation: Operation, context: EffectExecution<Operation, Effect>): void;
  afterEffect?(context: EffectExecution<Operation, Effect>): void;
}

/** Адаптер прежнего API эффектов поверх общего планировщика. */
export class ExecutionQueue<
  Operation,
  Effect extends QueuedEffect<Operation> = QueuedEffect<Operation>,
> extends EntryQueue<Effect> {
  constructor(hooks: ExecutionHooks<Operation, Effect>) {
    super({
      copy: (effect) =>
        hooks.copyEffect?.(effect) ?? { ...effect, operations: [...effect.operations] },
      canExecute: (effect) =>
        (effect.source === "death" || hooks.isOwnerAlive(effect.ownerId)) &&
        hooks.canExecuteEffect?.(effect) !== false,
      execute: (effect, entryContext) => {
        const context: EffectExecution<Operation, Effect> = {
          effect,
          emit: (...effects) => entryContext.emit(...effects),
        };

        for (const operation of effect.operations) {
          if (hooks.canExecute(operation, context)) {
            hooks.execute(operation, context);
          }
        }

        hooks.afterEffect?.(context);
      },
    });
  }
}
