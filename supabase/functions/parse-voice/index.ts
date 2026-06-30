// supabase/functions/parse-voice/index.ts
//
// Turns a spoken sentence ("I finished the morning creative and launched the
// Meta batch") into the list of task_keys the speaker said they completed.
//
// SECURITY: the Anthropic API key lives ONLY here, read from a Supabase secret
// (ANTHROPIC_API_KEY) at runtime. It is never shipped to the browser.
//
// Deploy:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//          supabase functions deploy parse-voice --no-verify-jwt
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

interface AvailableTask {
  task_key: string;
  label: string;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Server not configured" }, 500);

  // ── Parse request body ────────────────────────────────────────────────
  let transcript = "";
  let availableTasks: AvailableTask[] = [];
  try {
    const body = await req.json();
    transcript = String(body.transcript ?? "").trim();
    if (Array.isArray(body.available_tasks)) availableTasks = body.available_tasks;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Nothing to match against → return early, no model call.
  if (!transcript || !availableTasks.length) return json({ task_keys: [] });

  const validKeys = new Set(availableTasks.map((t) => t.task_key));
  const taskList = availableTasks.map((t) => `- ${t.task_key}: "${t.label}"`).join("\n");

  const system =
    `You parse a spoken sentence into the task_keys the speaker said they just finished.\n\n` +
    `Available tasks (task_key: label):\n${taskList}\n\n` +
    `Return ONLY a JSON array of the matching task_key strings — e.g. ["key-a","key-b"]. ` +
    `Return [] if none match. No prose, no markdown, only the raw JSON array. ` +
    `Match on meaning, not exact words, but never output a task_key that is not in the list above.`;

  // ── Ask Claude (Haiku 4.5) which keys were meant ──────────────────────
  try {
    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system,
      messages: [{ role: "user", content: transcript }],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();

    // Extract the JSON array defensively, then keep only known keys.
    let keys: string[] = [];
    const arr = text.match(/\[[\s\S]*\]/);
    if (arr) {
      try {
        const parsed = JSON.parse(arr[0]);
        if (Array.isArray(parsed)) {
          keys = parsed.filter((k): k is string => typeof k === "string" && validKeys.has(k));
        }
      } catch {
        // malformed array → treat as no match
      }
    }

    return json({ task_keys: keys });
  } catch (err) {
    console.error("parse-voice error:", err);
    return json({ error: "Parse failed" }, 502);
  }
});
