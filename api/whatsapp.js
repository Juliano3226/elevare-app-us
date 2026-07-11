// WhatsApp webhook (Twilio) — v2 com vínculo de usuário
// Novidade: busca o user_id na tabela `whatsapp_links` pelo número de quem
// mandou a mensagem. Se o número não estiver vinculado, responde orientando
// o cadastro. O gasto é gravado já com o user_id do dono da conta Elevare.

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

// Extrai valor, categoria, tipo (business/personal) e descrição usando Llama
async function extrairGasto(textoUsuario) {
  const prompt = `Extract expense information from this message and return ONLY valid JSON, nothing else.

Message: "${textoUsuario}"

Return this exact JSON structure:
{
  "amount": <number, the expense amount>,
  "category": "<one of: fuel, rent, groceries, utilities, marketing, software, supplies, food, transport, salary, other>",
  "type": "<business or personal>",
  "description": "<short description of what was purchased>",
  "confidence": "<high, medium, or low>"
}

If you cannot confidently extract an amount, set "confidence" to "low" and "amount" to null.
Rules:
- Infer "type" (business vs personal) from context. If unclear, default to "personal".
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

    // NOVO: busca o usuário vinculado a este telefone
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

    const gasto = await extrairGasto(textoParaAnalise);

    if (gasto.confidence === 'low' || gasto.amount === null) {
      res.setHeader('Content-Type', 'text/xml');
      return res
        .status(200)
        .send(
          respostaTwiML(
            "I couldn't identify the amount. Could you send it again? Ex: 'spent $40 on gas'"
          )
        );
    }

    // Grava no Supabase, agora com o user_id vinculado
    const { error } = await supabase.from('whatsapp_expenses').insert({
      phone_number: telefone,
      user_id: userId,
      amount: gasto.amount,
      category: gasto.category,
      type: gasto.type,
      description: gasto.description,
      original_message: textoParaAnalise,
      source: temAudio ? 'audio' : 'text',
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

    const tipoLabel = gasto.type === 'business' ? 'Business' : 'Personal';
    res.setHeader('Content-Type', 'text/xml');
    return res
      .status(200)
      .send(
        respostaTwiML(
          `✅ Logged: ${gasto.description} — $${gasto.amount} (${tipoLabel}, ${gasto.category})`
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
