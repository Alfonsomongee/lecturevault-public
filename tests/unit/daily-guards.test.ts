
import { RunBudget, estimateClassMinutes, budgetMinutesFromEnv } from '../../src/campus/daily-guards';

describe('RunBudget', () => {
  it('estimates recording + transcription + slack', () => {
    expect(estimateClassMinutes(117 * 60, 2)).toBeGreaterThan(90);
    expect(estimateClassMinutes(117 * 60, 2)).toBeLessThan(115);
  });
  it('leaves a class that no longer fits, as happened on 2026-11-10', () => {
    let t = 0;
    const budget = new RunBudget(150, () => t);
    t = 114 * 60000; // 01MUIN done 114 min into the run
    const r = budget.check(117 * 60, 2);
    expect(r.ok).toBe(false);
  });
  it('lets a class start when it fits', () => {
    const budget = new RunBudget(270, () => 0);
    expect(budget.check(117 * 60, 2).ok).toBe(true);
  });
  it('has no budget unless the env says so', () => {
    expect(budgetMinutesFromEnv({})).toBeNull();
    expect(budgetMinutesFromEnv({ DAILY_BUDGET_MINUTES: '270' })).toBe(270);
  });
});
