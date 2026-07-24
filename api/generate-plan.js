// api/generate-plan.js
// Vercel serverless function — same logic as the Express route, just in
// Vercel's function format (no app.listen(), Vercel handles that).
// Vercel automatically parses a JSON request body into req.body for you.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    if (!GEMINI_API_KEY) {
      res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in Vercel project settings.' });
      return;
    }

    const { name, examDate, subjects, hours, preferredTime } = req.body || {};

    if (!name || !examDate || !Array.isArray(subjects) || subjects.length === 0 || !hours || !preferredTime) {
      res.status(400).json({ error: 'Missing required fields: name, examDate, subjects, hours, preferredTime.' });
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exam = new Date(examDate + 'T00:00:00');
    const totalDays = Math.round((exam - today) / (1000 * 60 * 60 * 24));

    if (Number.isNaN(totalDays) || totalDays < 0) {
      res.status(400).json({ error: 'Exam date must be a valid date in the future.' });
      return;
    }

    const fmt = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const detailDays = Math.min(totalDays === 0 ? 1 : totalDays, 7);

    const systemPrompt =
      'You are a study planning assistant. Respond with ONLY raw JSON (no markdown fences, no commentary, no preamble). Follow the exact schema given by the user.';

    const userPrompt = `Create a personalized exam study plan as JSON.

Student: ${name}
Exam date: ${fmt(exam)} (today is ${fmt(today)})
Days remaining: ${totalDays}
Subjects: ${subjects.join(', ')}
Available study time: ${hours} hours/day
Preferred study time of day: ${preferredTime}

Rules:
- Prioritize subjects sensibly (more/harder subjects = higher priority) and note briefly why (max 10 words).
- dailyPlan must cover exactly ${detailDays} day(s) starting today, scheduled within the "${preferredTime}" part of the day, split into 2-4 short blocks per day (mix of study blocks and at least one short break), respecting the ${hours} hour/day budget.
- If days remaining > 7, ALSO include 2-4 "phases" spanning the full period (e.g. Foundation, Practice, Revision, Final Sprint) with short date ranges and a one-line focus each, and include a "revisionSchedule" of 2-4 entries dated in the final days before the exam.
- If days remaining <= 7, phases must be an empty array [], and revisionSchedule should cover the last 1-2 days before the exam.
- Include exactly 3-5 short, genuinely encouraging tips.
- Keep all text concise. No long sentences.
- Output ONLY this JSON shape, nothing else:
{
 "greeting": "one short warm sentence using the student's name",
 "countdownMessage": "one short sentence about the days remaining",
 "subjectPriorities": [{"subject":"","priority":"High|Medium|Low","hoursPerWeek":0,"note":""}],
 "phases": [{"label":"","dateRange":"","focus":""}],
 "dailyPlan": [{"day":"Day 1","date":"","blocks":[{"time":"","subject":"","activity":"","type":"study|break|revision"}]}],
 "revisionSchedule": [{"date":"","subjects":"","focus":""}],
 "tips": ["short motivational tip", "short motivational tip", "short motivational tip"]
}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      const detail = errBody?.error?.message || geminiRes.statusText;
      res.status(geminiRes.status).json({ error: `Gemini API error: ${detail}` });
      return;
    }

    const data = await geminiRes.json();
    const candidate = data?.candidates?.[0];
    const textBlocks = (candidate?.content?.parts || []).map((p) => p.text || '').join('\n');

    if (!textBlocks) {
      const blockReason = data?.promptFeedback?.blockReason;
      const finishReason = candidate?.finishReason;
      res.status(502).json({
        error: `Gemini returned no text (finishReason: ${finishReason || 'unknown'}${blockReason ? `, blockReason: ${blockReason}` : ''}).`,
      });
      return;
    }

    res.status(200).json({ text: textBlocks, totalDays });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error while generating the plan.' });
  }
};
