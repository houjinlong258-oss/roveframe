/** Source-adapted iteration counter; see THIRD_PARTY_NOTICES.md. */
export class IterationBudget {
  private count = 0;

  constructor(readonly maxTotal: number) {
    if (!Number.isSafeInteger(maxTotal) || maxTotal < 1) {
      throw new Error('Iteration budget must be a positive safe integer');
    }
  }

  consume(): boolean {
    if (this.count >= this.maxTotal) return false;
    this.count += 1;
    return true;
  }

  refund(): void { if (this.count > 0) this.count -= 1; }
  get used(): number { return this.count; }
  get remaining(): number { return Math.max(0, this.maxTotal - this.count); }
}
