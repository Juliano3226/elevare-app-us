// Powers the in-app AI assistant chat. Uses Groq's OpenAI-compatible
// chat completions endpoint. This was referenced by the frontend
// (fetch('/api/chat')) but did not exist in the repository — recreated here
// so the feature actually works in production.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { system, messages } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing messages' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'AI assistant is not configured' });
    }

    const payload = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system || 'You are a helpful business consultant.' },
        ...messages.slice(-10),
      ],
      max_tokens: 600,
      temperature: 0.7,
    };

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', errText);
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable' });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content || '';

    return res.status(200).json({ text });
  } catch (err) {
    console.error('chat handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
