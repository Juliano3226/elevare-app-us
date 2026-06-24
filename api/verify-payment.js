// The frontend NEVER decides "payment confirmed" by itself (no localStorage,
// no client guesswork). This endpoint asks Stripe directly, using the secret
// key, whether the given Checkout Session was actually paid. It also
// upserts a row into paid_customers as a fast-path, in case the webhook
// hasn't landed yet (webhooks can arrive a few seconds late).

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session_id } = req.query;
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      return res.status(200).json({ paid: false });
    }

    const email = session.customer_details?.email || session.customer_email;
    const plan = session.metadata?.plan || null;
    const customerId = session.customer;
    const subscriptionId = session.subscription?.id || session.subscription;
    const periodEnd = session.subscription?.current_period_end
      ? new Date(session.subscription.current_period_end * 1000).toISOString()
      : null;

    if (!email) {
      return res.status(200).json({ paid: false });
    }

    // Fast-path upsert so complete-signup can rely on this table immediately,
    // even if the webhook event hasn't been processed yet.
    await supa.from('paid_customers').upsert(
      {
        email,
        plan,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        subscription_status: 'active',
        current_period_end: periodEnd,
        last_session_id: session.id,
      },
      { onConflict: 'email' }
    );

    return res.status(200).json({
      paid: true,
      email,
      plan,
      customer_id: customerId,
      subscription_id: subscriptionId,
    });
  } catch (err) {
    console.error('verify-payment error:', err.message);
    return res.status(500).json({ error: 'Could not verify payment' });
  }
}
