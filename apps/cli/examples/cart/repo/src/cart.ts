export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export interface Coupon {
  code: string;
  /** Percentage off, 0 to 100. */
  pct: number;
  expiresAt: Date;
}

export function total(items: Item[]): number {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].qty;
  }
  return sum;
}

export function applyCoupon(sum: number, coupon: Coupon | undefined): number {
  if (coupon && coupon.expiresAt > new Date()) {
    return sum - sum * coupon.pct;
  }
  return sum;
}

export async function checkout(items: Item[], coupon?: Coupon): Promise<{ charged: number }> {
  const amount = applyCoupon(total(items), coupon);
  const res = await fetch('https://payments.example.com/charge', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
  const data = (await res.json()) as { charged: number };
  return { charged: data.charged };
}
