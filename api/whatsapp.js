// WhatsApp webhook (Twilio) — v3
// Agora grava direto na tabela `transactions` (a que o dashboard da Elevare lê),
// com o mapeamento: amount → value, description → descricao, category → cat,
// e type fixo em 'expense' (gasto). O user_id vem do vínculo em `whatsapp_links`.

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

// Extrai valor, categoria e descrição usando Llama.
// Também detecta se é receita (income) ou gasto (expense).
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

    const userId = await buscarUsuarioPorTelefone(telefone);

    if (!userId) {
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            "This number isn't linked to an Elevare account yet. Please link your WhatsApp number in the app settings first."
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

    // Grava direto na tabela `transactions` que o dashboard da Elevare lê
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
