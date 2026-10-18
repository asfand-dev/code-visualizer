import { CURRENCY } from '@/app/settings';

/** Charges the closing balance of a deleted account directly through Stripe. */
export async function chargeClosingBalance(customerId: string, amount = 0): Promise<void> {
  if (amount <= 0) return;
  await fetch('https://api.stripe.com/v1/charges', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY ?? ''}` },
    body: new URLSearchParams({ customer: customerId, amount: String(amount), currency: CURRENCY }),
  });
}
