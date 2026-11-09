// Global RPC rate limiter: a token bucket with a priority queue, so the bot never floods an RPC
// endpoint with back-to-back calls (the 429 storm). Priorities: 0 = close positions (exits),
// 1 = entries, 2 = tick sampling, 3 = everything else (mayhem flag, meta, ...).
//
// The bucket refills at RPC_MAX_RPS tokens per second (default 5) and holds a small burst. When the
// bucket is empty, callers queue up; within the same priority they are served FIFO, and a higher
// priority always jumps ahead of a lower one. Nothing is dropped: slow is better than wrong.
export class RateLimiter {
  constructor({ maxRps = Number(process.env.RPC_MAX_RPS) || 5, burst = 2 } = {}) {
    this.maxRps = Math.max(0.1, Number(maxRps));
    this.burst = Math.max(1, Number(burst));
    this.tokens = this.burst;
    this.lastRefill = Date.now();
    this.waiters = []; // { priority, resolve }
    this.stats = { granted: 0, waited: 0, maxQueueMs: 0 };
  }

  _refill() {
    const now = Date.now();
    const add = ((now - this.lastRefill) / 1000) * this.maxRps;
    if (add > 0) {
      this.tokens = Math.min(this.burst, this.tokens + add);
      this.lastRefill = now;
    }
  }

  async acquire(priority = 3) {
    this._refill();
    if (this.tokens >= 1 && this.waiters.length === 0) {
      this.tokens -= 1;
      this.stats.granted += 1;
      return;
    }
    return new Promise((resolve) => {
      const item = { priority, resolve, enqueuedAt: Date.now() };
      let i = 0;
      while (i < this.waiters.length && this.waiters[i].priority <= priority) i += 1;
      this.waiters.splice(i, 0, item);
      this.stats.waited += 1;
      this._pump();
    });
  }

  _pump() {
    this._refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const item = this.waiters.shift();
      this.tokens -= 1;
      this.stats.granted += 1;
      this.stats.maxQueueMs = Math.max(this.stats.maxQueueMs, Date.now() - item.enqueuedAt);
      item.resolve();
    }
    if (this.waiters.length > 0 && this.tokens < 1 && !this._timer) {
      const need = ((1 - this.tokens) / this.maxRps) * 1000;
      this._timer = setTimeout(() => {
        this._timer = null;
        this._pump();
      }, Math.max(1, need));
    }
  }
}

export const rpcLimiter = new RateLimiter();
