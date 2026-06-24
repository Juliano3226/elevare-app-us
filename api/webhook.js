// Stripe webhook — single source of truth for subscription status.
//
// Design principle: this webhook NEVER assumes a `profiles` row already
// exists. It always upserts `paid_customers` (keyed by email, the only
// identifier Stripe reliably gives us before signup), and ALSO updates
// `profiles` whenever a matching row exists (keyed by stripe_customer_id,
// which is reliable after signup). This way it works correctly no matter
// which order things happen in.

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || session.payment_status !== 'paid') break;

        const email = session.customer_details?.email || session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const plan = session.metadata?.plan || null;

        if (!email) break;

        await supa.from('paid_customers').upsert(
          {
            email,
            plan,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: 'active',
            last_session_id: session.id,
          },
          { onConflict: 'email' }
        );

        // If an account already exists for this customer (re-subscribe
        // case), keep it in sync too.
        await supa
          .from('profiles')
          .update({
            subscription_status: 'active',
            stripe_subscription_id: subscriptionId,
            plano: plan || undefined,
          })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;
        const periodEndIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

        await supa
          .from('paid_customers')
          .update({ subscription_status: 'active', current_period_end: periodEndIso })
          .eq('stripe_customer_id', customerId);

        await supa
          .from('profiles')
          .update({ subscription_status: 'active', current_period_end: periodEndIso })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        await supa
          .from('paid_customers')
          .update({ subscription_status: 'past_due' })
          .eq('stripe_customer_id', customerId);

        await supa
          .from('profiles')
          .update({ subscription_status: 'past_due' })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        // Mirror Stripe's own status (covers e.g. 'unpaid', 'incomplete_expired', 'trialing')
        const status = subscription.status === 'active' ? 'active'
          : subscription.status === 'past_due' ? 'past_due'
          : subscription.status === 'canceled' ? 'canceled'
          : subscription.status;

        await supa
          .from('paid_customers')
          .update({ subscription_status: status })
          .eq('stripe_customer_id', customerId);

        await supa
          .from('profiles')
          .update({ subscription_status: status })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        await supa
          .from('paid_customers')
          .update({ subscription_status: 'canceled' })
          .eq('stripe_customer_id', customerId);

        await supa
          .from('profiles')
          .update({ subscription_status: 'canceled' })
          .eq('stripe_customer_id', customerId);

        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
