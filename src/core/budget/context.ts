/** In-process budget scope; admission can detect it without importing a provider gateway. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BudgetTracker } from './budget-tracker.ts';
const budgetStore = new AsyncLocalStorage<BudgetTracker>();
export function withBudgetTracker<T>(tracker: BudgetTracker, fn: () => Promise<T>): Promise<T> { return budgetStore.run(tracker, fn); }
export function getCurrentBudgetTracker(): BudgetTracker | null { return budgetStore.getStore() ?? null; }
