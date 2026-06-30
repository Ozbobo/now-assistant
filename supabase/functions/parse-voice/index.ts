// supabase/functions/parse-voice/index.ts
//
// Voice brain for the NOW app. One mic handles two intents:
//   • CHECK-OFF — "I finished the morning creative" → returns task_keys
//   • QUERY     — "what's next?" / "what's left?"   → returns a spoken reply
// Either can happen alone or together (action: complete | query | mixed).
//
// SECURITY: the Anthropic API key lives ONLY here, read from a Supabase secret
// (ANTHROPIC_API_KEY) at runtime. It is never shipped to the browser.
//
// Deploy (dashboard or CLI). CLI:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy parse-voice --no-verify-jwt
import Anthropic from "npm:@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ action: "query", task_keys: [], reply: "Method not allowed." }, 405);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ action: "query", task_keys: [], reply: "The assistant isn't configured yet." }, 500);
  }

  // ── Parse request ─────────────────────────────────────────────────────
  let transcript = "";
  // deno-lint-ignore no-explicit-any
  let context: any = {};
  try {
    const body = await req.json();
    transcript = String(body.transcript ?? "").trim();
    context = body.context ?? {};
  } catch {
    return json({ action: "query", task_keys: [], reply: "Didn't catch that — try again?" }, 400);
  }

  const todayTasks = Array.isArray(context.today_tasks) ? context.today_tasks : [];
  const validKeys = new Set(todayTasks.map((t: { task_key: string }) => t.task_key));
  const cur = context.current_block ?? {};
  const nxt = context.next_block ?? {};

  const systemPrompt =
`You are Osvaldo's voice assistant inside his personal scheduling app. You handle two kinds of voice input:

1. CHECK-OFF: He reports completing tasks. Return the matching task_keys.
2. QUERY: He asks what he should be doing, what's next, what's left, whether he did something, etc. Give a short spoken answer.

Either kind can happen alone, or together in one sentence.

Current context:
- Day: ${context.current_day ?? "unknown"}
- Time: ${context.current_time ?? "unknown"}
- Right now he should be: "${cur.title ?? "—"}" (${cur.start ?? "?"} – ${cur.end ?? "?"})${cur.note ? " — " + cur.note : ""}
- Next up: "${nxt.title ?? "—"}" at ${nxt.start ?? "?"}${nxt.note ? " — " + nxt.note : ""}

Today's tasks (with completion status):
${todayTasks.map((t: { completed: boolean; task_key: string; label: string; suggested_time: string }) =>
  `- [${t.completed ? "x" : " "}] ${t.task_key}: "${t.label}" (suggested ${t.suggested_time})`).join("\n") || "- (none)"}

Voice style for replies:
- Direct and warm. Short sentences. Like a friend who knows your day.
- No "Hello!" or "Sure!" preamble. Just the answer.
- Never read out task_keys — use the human labels.
- If he asks what to do now, lead with the activity, not the time.
- If he asks something outside his schedule (weather, news, etc.), say you only know his schedule.

Only put a task_key in "task_keys" if he actually reported FINISHING it (not when he merely asks about it). Never invent a task_key that is not in the list above.

Return ONLY a JSON object, no markdown:
{ "action": "complete" | "query" | "mixed", "task_keys": ["..."], "reply": "short spoken reply" }`;

  // ── Ask Claude (Haiku 4.5) ────────────────────────────────────────────
  try {
    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: transcript || "(no speech detected)" }],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();

    const obj = text.match(/\{[\s\S]*\}/);
    // deno-lint-ignore no-explicit-any
    const parsed: any = obj ? JSON.parse(obj[0]) : {};

    const keys: string[] = Array.isArray(parsed.task_keys)
      ? parsed.task_keys.filter((k: unknown): k is string => typeof k === "string" && validKeys.has(k))
      : [];
    const action = ["complete", "query", "mixed"].includes(parsed.action)
      ? parsed.action
      : (keys.length ? "complete" : "query");
    const reply =
      typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "Done.";

    return json({ action, task_keys: keys, reply });
  } catch (err) {
    console.error("parse-voice error:", err);
    return json({ action: "query", task_keys: [], reply: "Sorry, something went wrong. Try again?" }, 502);
  }
});
