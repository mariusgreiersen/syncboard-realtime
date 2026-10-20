/** Token bucket used to limit mutation events per socket. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  tryTake(): boolean {
    const current = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((current - this.updatedAt) / 1000) * this.refillPerSecond);
    this.updatedAt = current;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
