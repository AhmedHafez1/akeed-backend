export interface UsagePool {
  used: number;
  limit: number;
  remaining: number;
}
export interface UsagePools {
  akeed: UsagePool;
  ownNumber: UsagePool;
}

export function usagePool(used: number, limit: number): UsagePool {
  return { used, limit, remaining: Math.max(0, limit - used) };
}
