// api/whatsapp-link-code.js
// Gera um código de verificação pro usuário logado vincular o WhatsApp dele.
// Requisitos: usuário autenticado (token do Supabase) e assinatura ativa.
//
// O frontend chama: POST /api/whatsapp-link-code
// com o header: Authorization: Bearer <access_token do Supabase>
// Resposta: { code: "ELV-4829", expires_in_minutes: 15 }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gera um código curto legível, ex: ELV-4829
function gerarCodigo() {
  const numero = Math.floor(1000 + Math.random() * 9000);
  return `ELV-${numero}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Valida o usuário logado pelo token enviado pelo frontend
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // 2. Verifica se o usuário tem assinatura ativa.
    // Ajuste o nome da tabela/coluna se o seu controle de assinatura
    // for diferente — aqui usamos `profiles.subscription_status`,
    // e como fallback checamos a tabela `paid_customers` pelo email.
    let assinaturaAtiva = false;

    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_status')
      .eq('id', user.id)
      .single();

    if (profile && ['active', 'trialing'].includes(profile.subscription_status)) {
      assinaturaAtiva = true;
    }

    if (!assinaturaAtiva) {
      const { data: paid } = await supabase
        .from('paid_customers')
        .select('id')
        .eq('email', user.email)
        .single();
      if (paid) assinaturaAtiva = true;
    }

    if (!assinaturaAtiva) {
      return res.status(403).json({
        error: 'Active subscription required to use the WhatsApp assistant',
      });
    }

    // 3. Remove códigos antigos deste usuário e gera um novo
    await supabase.from('whatsapp_link_codes').delete().eq('user_id', user.id);

    const code = gerarCodigo();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    const { error: insertError } = await supabase
      .from('whatsapp_link_codes')
      .insert({
        user_id: user.id,
        code,
        expires_at: expiresAt.toISOString(),
      });

    if (insertError) {
      console.error('Erro ao salvar código:', insertError);
      return res.status(500).json({ error: 'Failed to generate code' });
    }

    return res.status(200).json({ code, expires_in_minutes: 15 });
  } catch (err) {
    console.error('Erro no endpoint de código:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
