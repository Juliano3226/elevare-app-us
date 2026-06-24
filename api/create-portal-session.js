// Lets an existing, authenticated user manage/update their payment method
// or fix a past_due subscription via Stripe's hosted Billing Portal.
// Requires the caller to be a logged-in Supabase user (we verify the JWT
// server-side) so nobody can request a portal session for someone else's
// stripe_customer_id.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supaAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Missing auth token' });
    }

    const { data: userData, error: userErr } = await supaAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const { data: profile, error: profileErr } = await supaAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userData.user.id)
      .single();

    if (profileErr || !profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing record found for this account' });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${origin}/`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('create-portal-session error:', err.message);
    return res.status(500).json({ error: 'Could not open billing portal' });
  }
}
