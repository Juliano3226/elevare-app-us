// Creates a real Stripe Checkout Session (subscription mode) for the
// chosen plan. Replaces the old static Payment Links. The session id
// returned in the success_url is the only thing the frontend is allowed
// to trust later, and only after /api/verify-payment confirms it server-side.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC,
  pro: process.env.STRIPE_PRICE_PRO,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan } = req.body || {};

    if (plan !== 'basic' && plan !== 'pro') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(500).json({ error: 'Price not configured for this plan' });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Stripe collects the customer's email itself during Checkout.
      // We never need to (and must never) trust a client-supplied email.
      success_url: `${origin}/?paid_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout_canceled=1`,
      metadata: { plan },
      subscription_data: {
        trial_period_days: 14,
        metadata: { plan },
      },
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
}
