export function getBillingPeriodStart(
  billingActivatedAt?: string | Date | null,
  now = new Date(),
): string {
  if (!billingActivatedAt) {
    const fallback = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return fallback.toISOString().slice(0, 10);
  }

  const activation = new Date(billingActivatedAt);
  if (isNaN(activation.getTime())) {
    const fallback = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return fallback.toISOString().slice(0, 10);
  }

  const msPerDay = 86_400_000;
  const elapsedMs = now.getTime() - activation.getTime();
  if (elapsedMs < 0) {
    return activation.toISOString().slice(0, 10);
  }

  const elapsedDays = Math.floor(elapsedMs / msPerDay);
  const completedCycles = Math.floor(elapsedDays / 30);
  const periodStart = new Date(
    activation.getTime() + completedCycles * 30 * msPerDay,
  );
  return periodStart.toISOString().slice(0, 10);
}

export function getBillingPeriodEnd(periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}
