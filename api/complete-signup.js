// This is the ONLY way an account gets created in this app.
// The email is never trusted from the client/form — it is read straight
// from the verified Stripe payment record (paid_customers), keyed by the
// session_id. This makes it impossible to register an account that wasn't
// actually paid for, and impossible to register under a different email
// than the one that paid.

import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { session_id, password, nome, empresa, setor } = req.body || {};

    if (!session_id || !password || !nome || !empresa) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // 1. Look up the verified payment record. This row only exists if
    //    verify-payment (or the webhook) already confirmed payment_status === 'paid'.
    const { data: paidRecord, error: paidErr } = await supa
      .from('paid_customers')
      .select('*')
      .eq('last_session_id', session_id)
      .in('subscription_status', ['active', 'trialing'])
      .maybeSingle();

    if (paidErr || !paidRecord) {
      return res.status(403).json({ error: 'No verified payment found for this session' });
    }

    const email = paidRecord.email;

    // 2. Prevent re-registering an already-used paid session/email.
    const { data: existing } = await supa
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'An account already exists for this email. Please sign in instead.' });
    }

    // 3. Create the Supabase Auth user server-side with the service role.
    //    email_confirm: true skips the confirmation email since payment
    //    already proved ownership of a working inbox via Stripe receipt.
    const { data: created, error: createErr } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nome, empresa, setor, plano: paidRecord.plan },
    });

    if (createErr) {
      return res.status(400).json({ error: createErr.message });
    }

    const userId = created.user.id;

    // 4. Insert the profile with subscription data straight from the
    //    verified Stripe record — never from anything the client claimed.
    const { error: profileErr } = await supa.from('profiles').upsert({
      id: userId,
      email,
      nome,
      empresa,
      setor,
      plano: paidRecord.plan,
      subscription_status: paidRecord.subscription_status,
      stripe_customer_id: paidRecord.stripe_customer_id,
      stripe_subscription_id: paidRecord.stripe_subscription_id,
      current_period_end: paidRecord.current_period_end,
    });

    if (profileErr) {
      console.error('profile insert error:', profileErr.message);
      return res.status(500).json({ error: 'Account created but profile setup failed. Contact support.' });
    }

    // 5. Link the paid_customers row to this user for future reference.
    await supa.from('paid_customers').update({ user_id: userId }).eq('email', email);

    return res.status(200).json({ success: true, email });
  } catch (err) {
    console.error('complete-signup error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
