// api/whatsapp.js — v4
// Novidade: reconhece códigos de verificação (formato ELV-1234) enviados
// pelo WhatsApp. Quando o usuário manda o código gerado no app, o webhook
// valida e vincula o número dele em `whatsapp_links` automaticamente.
// Depois de vinculado, todas as mensagens registram transações normalmente.

import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: true,
  },
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Detecta se a mensagem é um código de verificação (ex: ELV-4829)
function extrairCodigoVerificacao(texto) {
  const match = (texto || '').trim().toUpperCase().match(/^ELV-\d{4}$/);
  return match ? match[0] : null;
}

// Valida o código e cria o vínculo telefone → usuário
async function processarCodigoVerificacao(codigo, telefone) {
  const { data: registro, error } = await supabase
    .from('whatsapp_link_codes')
    .select('user_id, expires_at')
    .eq('code', codigo)
    .single();

  if (error || !registro) {
    return { ok: false, motivo: 'invalido' };
  }

  if (new Date(registro.expires_at) < new Date()) {
    return { ok: false, motivo: 'expirado' };
  }

  // Cria ou atualiza o vínculo (upsert pelo telefone)
  const { error: upsertError } = await supabase
    .from('whatsapp_links')
    .upsert(
      { phone_number: telefone, user_id: registro.user_id },
      { onConflict: 'phone_number' }
    );

  if (upsertError) {
    console.error('Erro ao vincular número:', upsertError);
    return { ok: false, motivo: 'erro' };
  }

  // Remove o código usado
  await supabase.from('whatsapp_link_codes').delete().eq('code', codigo);

  return { ok: true };
}

// Busca o user_id vinculado a este número de telefone
async function buscarUsuarioPorTelefone(telefone) {
  const { data, error } = await supabase
    .from('whatsapp_links')
    .select('user_id')
    .eq('phone_number', telefone)
    .single();

  if (error || !data) return null;
  return data.user_id;
}

// Baixa o áudio do Twilio (a URL de mídia exige autenticação básica)
async function baixarAudioTwilio(mediaUrl) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar áudio do Twilio: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// Transcreve áudio usando Groq Whisper
async function transcreverAudio(audioBuffer) {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), 'audio.ogg');
  formData.append('model', 'whisper-large-v3-turbo');

  const response = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha na transcrição Groq: ${errorText}`);
  }

  const data = await response.json();
  return data.text;
}

// Extrai valor, categoria, fluxo (expense/income) e descrição usando Llama
async function extrairTransacao(textoUsuario) {
  const prompt = `Extract transaction information from this message and return ONLY valid JSON, nothing else.

Message: "${textoUsuario}"

Return this exact JSON structure:
{
  "amount": <number, the transaction amount>,
  "flow": "<expense or income — expense if money was spent/paid, income if money was received/earned>",
  "category": "<one of: fuel, rent, groceries, utilities, marketing, software, supplies, food, transport, salary, sales, other>",
  "description": "<short description>",
  "confidence": "<high, medium, or low>"
}

If you cannot confidently extract an amount, set "confidence" to "low" and "amount" to null.
Rules:
- Default "flow" to "expense" when unclear.
- Respond in English regardless of the input language.
- Return ONLY the JSON object, no markdown, no explanation.`;

  const response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha na extração Groq: ${errorText}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content.trim();
  const jsonLimpo = raw.replace(/```json\n?|```\n?/g, '').trim();

  return JSON.parse(jsonLimpo);
}

// Monta a resposta TwiML que o Twilio espera
function respostaTwiML(mensagem) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${mensagem}</Message>
</Response>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const { Body, From, NumMedia, MediaUrl0, MediaContentType0 } = req.body;
    const telefone = (From || '').replace('whatsapp:', '');

    // 1. Se a mensagem for um código de verificação, processa o vínculo
    const codigo = extrairCodigoVerificacao(Body);
    if (codigo) {
      const resultado = await processarCodigoVerificacao(codigo, telefone);
      res.setHeader('Content-Type', 'text/xml');

      if (resultado.ok) {
        return res
          .status(200)
          .send(
            respostaTwiML(
              '✅ Your WhatsApp number is now linked to your Elevare account! Send me expenses like: "spent $40 on gas today"'
            )
          );
      }

      const mensagens = {
        invalido: 'This code is not valid. Generate a new one in the Elevare app settings.',
        expirado: 'This code has expired. Generate a new one in the Elevare app settings.',
        erro: 'Something went wrong linking your number. Please try again.',
      };

      return res
        .status(200)
        .send(respostaTwiML(mensagens[resultado.motivo] || mensagens.erro));
    }

    // 2. Fluxo normal: busca o usuário vinculado
    const userId = await buscarUsuarioPorTelefone(telefone);

    if (!userId) {
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            "This number isn't linked to an Elevare account yet. Open the Elevare app, go to Settings, and generate your verification code."
          )
        );
    }

    let textoParaAnalise = Body || '';

    const temAudio = Number(NumMedia) > 0 && MediaContentType0?.startsWith('audio');
    if (temAudio) {
      const audioBuffer = await baixarAudioTwilio(MediaUrl0);
      textoParaAnalise = await transcreverAudio(audioBuffer);
    }

    if (!textoParaAnalise || textoParaAnalise.trim().length === 0) {
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            "I didn't catch that. Try something like: 'spent $40 on gas today'"
          )
        );
    }

    const transacao = await extrairTransacao(textoParaAnalise);

    if (transacao.confidence === 'low' || transacao.amount === null) {
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            "I couldn't identify the amount. Could you send it again? Ex: 'spent $40 on gas'"
          )
        );
    }

    const { error } = await supabase.from('transactions').insert({
      user_id: userId,
      type: transacao.flow === 'income' ? 'income' : 'expense',
      descricao: transacao.description,
      value: transacao.amount,
      cat: transacao.category,
      date: new Date().toISOString(),
    });

    if (error) {
      console.error('Erro ao gravar no Supabase:', error);
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            'Got your expense but had trouble saving it. Please try again in a moment.'
          )
        );
    }

    const flowLabel = transacao.flow === 'income' ? 'Income' : 'Expense';
    res.setHeader('Content-Type', 'text/xml');
    return res
      .status(200)
      .send(
        respostaTwiML(
          `✅ Logged: ${transacao.description} — $${transacao.amount} (${flowLabel}, ${transacao.category})`
        )
      );
  } catch (err) {
    console.error('Erro no webhook do WhatsApp:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res
      .status(200)
      .send(
        respostaTwiML(
          'Something went wrong processing your message. Please try again.'
        )
      );
  }
}
