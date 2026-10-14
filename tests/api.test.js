import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate } from "../functions/_lib/auth.js";
import { whisperPrompt, MA_TERMS } from "../functions/_lib/prompts.js";
import { onRequest } from "../functions/api/[[path]].js";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function makeToken(payload, kid = "k1") {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid };
  const head = b64url(JSON.stringify({ alg: "RS256", kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(head + "." + body));
  return { token: `${head}.${body}.${b64url(sig)}`, jwk };
}

const ENV = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud1", ALLOWED_EMAILS: "boss@example.com", ADMIN_EMAILS: "admin@example.com" };
const req = (token) => new Request("https://x/api/all", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

test("Access JWT: 許可メールは通り、それ以外は拒否", async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const ok = await makeToken({ email: "Boss@example.com", aud: ["aud1"], exp, iss: "https://team.cloudflareaccess.com" });
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [ok.jwk] }));
  assert.deepEqual(await authenticate(req(ok.token), ENV), { email: "boss@example.com", admin: false });

  const stranger = await makeToken({ email: "x@example.com", aud: ["aud1"], exp }, "k2");
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [stranger.jwk] }));
  assert.equal((await authenticate(req(stranger.token), ENV)).status, 403);

  const wrongAud = await makeToken({ email: "boss@example.com", aud: ["other"], exp }, "k3");
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [wrongAud.jwk] }));
  assert.equal((await authenticate(req(wrongAud.token), ENV)).status, 401);

  const expired = await makeToken({ email: "boss@example.com", aud: ["aud1"], exp: 1 }, "k4");
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [expired.jwk] }));
  assert.equal((await authenticate(req(expired.token), ENV)).status, 401);

  assert.equal((await authenticate(req(""), ENV)).status, 401);
  assert.equal((await authenticate(req(ok.token), { ...ENV, ACCESS_AUD: "" })).status, 503);
});

test("Whisper initial_prompt: M&A用語・辞書を含み、新しい名前を優先し、上限内", () => {
  const clients = Array.from({ length: 80 }, (_, i) => ({ id: "c" + i, company: `株式会社サンプル商事${i}`, updatedAt: i, cases: [] }));
  const p = whisperPrompt({ clients, partners: [{ name: "日本M&Aセンター", persons: [{ name: "佐藤" }], updatedAt: 1000 }], settings: { dict: [{ word: "ビズハブ" }] } });
  MA_TERMS.forEach((t) => assert.ok(p.includes(t), t));
  assert.ok(p.includes("ビズハブ"));
  assert.ok(p.includes("日本M&Aセンター") && p.includes("株式会社サンプル商事79"));
  assert.ok(!p.includes("株式会社サンプル商事0、"));
  assert.ok(p.length < 180, String(p.length));
});

test("transcribe: WAVをbase64でWhisperに渡し、language=ja と initial_prompt を付ける", async () => {
  let called;
  const db = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => [{ results: [{ data: JSON.stringify({ id: "c1", company: "株式会社テスト", cases: [] }) }] }, { results: [] }, { results: [] }, { results: [] }],
  };
  const env = { DB: db, AI: { run: async (model, input) => { called = { model, input }; return { text: " 株式会社テストとNDAを結んだ。ご視聴ありがとうございました " }; } } };
  const res = await onRequest({ request: new Request("https://x/api/transcribe", { method: "POST", body: new Uint8Array([1, 2, 3]) }), env, data: { user: { admin: false } } });
  assert.deepEqual(await res.json(), { text: "株式会社テストとNDAを結んだ。" });
  assert.equal(called.model, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(called.input.audio, "AQID");
  assert.equal(called.input.language, "ja");
  assert.ok(called.input.initial_prompt.includes("株式会社テスト"));
});
