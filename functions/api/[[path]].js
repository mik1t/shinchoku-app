import Anthropic from "@anthropic-ai/sdk";
import { json } from "../_lib/auth.js";
import { sortPrompt, minutesPrompt, whisperPrompt } from "../_lib/prompts.js";

const TABLES = ["clients", "partners", "minutes", "settings"];
const CLAUDE_MODEL = "claude-sonnet-5-5";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 1チャンク（16kHz・モノラルWAVで約4分）まで

export async function onRequest(ctx) {
  const { request, env, data } = ctx;
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const m = request.method;
  try {
    if (m === "GET" && seg[0] === "all" && seg.length === 1) return json({ ...(await loadAll(env)), me: data.user });
    if (TABLES.includes(seg[0]) && seg.length === 2) {
      if (m === "PUT") return await putRow(env, seg[0], seg[1], request);
      if (m === "DELETE") {
        await env.DB.prepare(`DELETE FROM ${seg[0]} WHERE id = ?`).bind(seg[1]).run();
        return json({ ok: true });
      }
    }
    if (m === "POST" && seg[0] === "import" && seg.length === 1) return await importAll(env, request, data.user, url);
    if (m === "POST" && seg[0] === "transcribe" && seg.length === 1) return await transcribe(env, request);
    if (m === "POST" && seg[0] === "sort" && seg.length === 1) return await sort(env, request);
    if (m === "POST" && seg[0] === "minutes" && seg.length === 1) return await minutes(env, request);
    return json({ error: "not_found" }, 404);
  } catch (e) {
    const code = e?.code || "server_error";
    console.error(code, e?.message);
    return json({ error: code }, e?.status || 500);
  }
}

class ApiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function loadAll(env) {
  const out = {};
  const res = await env.DB.batch(TABLES.map((t) => env.DB.prepare(`SELECT data FROM ${t}`)));
  TABLES.forEach((t, i) => {
    out[t] = (res[i].results || []).map((r) => {
      try { return JSON.parse(r.data); } catch (e) { return null; }
    }).filter(Boolean);
  });
  out.settings = out.settings.find((s) => s.id === "main") || { id: "main", dict: [] };
  return out;
}

const upsert = (env, table, doc) =>
  env.DB.prepare(`INSERT INTO ${table} (id, data, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(String(doc.id), JSON.stringify(doc), Number(doc.updatedAt) || Date.now());

async function putRow(env, table, id, request) {
  const doc = await request.json().catch(() => null);
  if (!doc || typeof doc !== "object" || String(doc.id) !== id) throw new ApiError("bad_request");
  if (table === "settings" && id !== "main") throw new ApiError("bad_request");
  await upsert(env, table, doc).run();
  return json({ ok: true });
}

// プロトタイプの「全データを書き出す（移行用）」JSON を取り込む。初回のみ（?force=1 で上書き取り込み）。
async function importAll(env, request, user, url) {
  if (!user.admin) throw new ApiError("forbidden", 403);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.clients)) throw new ApiError("bad_request");
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM clients").first();
  if (cnt?.n > 0 && url.searchParams.get("force") !== "1") throw new ApiError("already_has_data", 409);
  const stmts = [];
  const add = (t, arr) => (Array.isArray(arr) ? arr : []).forEach((d) => d && d.id && stmts.push(upsert(env, t, d)));
  add("clients", body.clients);
  add("partners", body.partners);
  add("minutes", body.minutes);
  if (body.settings) stmts.push(upsert(env, "settings", { ...body.settings, id: "main" }));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, clients: body.clients.length, partners: (body.partners || []).length, minutes: (body.minutes || []).length });
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Whisper がよく出す無音時の定型ハルシネーション
const HALLUCINATIONS = /(ご視聴ありがとうございました|ご覧いただきありがとうございます|チャンネル登録(を)?お願いします|字幕(は|by).*$)/g;

async function transcribe(env, request) {
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw new ApiError("empty_audio");
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new ApiError("audio_too_large", 413);
  const all = await loadAll(env);
  const initial_prompt = whisperPrompt(all);
  const out = await env.AI.run(WHISPER_MODEL, {
    audio: toBase64(buf),
    task: "transcribe",
    language: "ja",
    vad_filter: true,
    condition_on_previous_text: false,
    initial_prompt,
  });
  const text = String(out?.text || "").replace(HALLUCINATIONS, "").trim();
  return json({ text });
}

async function askJSON(env, prompt) {
  if (!env.ANTHROPIC_API_KEY) throw new ApiError("no_api_key", 503);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // パース失敗時は1回だけ再試行
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new ApiError("rate_limited", 429);
      if (e instanceof Anthropic.AuthenticationError) throw new ApiError("no_api_key", 503);
      throw new ApiError("ai_failed", 502);
    }
    if (res.stop_reason === "refusal") throw new ApiError("refused", 422);
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = parseJSON(text);
    if (parsed) return parsed;
  }
  throw new ApiError("invalid_json", 502);
}

function parseJSON(text) {
  const s = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(s); } catch (e) { /* 前後に文章が付いた場合 */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* fallthrough */ }
  }
  return null;
}

async function sort(env, request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) throw new ApiError("empty_text");
  const all = await loadAll(env);
  return json(await askJSON(env, sortPrompt(all, text, body.focusClientId || null)));
}

async function minutes(env, request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) throw new ApiError("empty_text");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
  const all = await loadAll(env);
  return json(await askJSON(env, minutesPrompt(all, text, date)));
}
