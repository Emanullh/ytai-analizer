interface CacheItem<V> {
  expiresAt: number;
  value: V;
}

export class SimpleCache<K, V> {
  private readonly store = new Map<K, CacheItem<V>>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  clear(): void {
    this.store.clear();
  }
}
