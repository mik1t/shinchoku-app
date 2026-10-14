// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を検証し、許可メールか確認する。
// Access 側でもブロックしているが、API は二重に守る（Access の設定漏れ・プレビューURL対策）。

const certCache = { at: 0, keys: null, team: "" };

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(team) {
  if (certCache.keys && certCache.team === team && Date.now() - certCache.at < 10 * 60 * 1000) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs fetch failed");
  const j = await r.json();
  certCache.keys = j.keys || [];
  certCache.team = team;
  certCache.at = Date.now();
  return certCache.keys;
}

async function verifyAccessJWT(token, team, aud) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = b64urlJSON(parts[0]);
  const payload = b64urlJSON(parts[1]);
  let keys = await getKeys(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    certCache.keys = null; // 鍵ローテーション直後
    keys = await getKeys(team);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss && payload.iss !== `https://${team}`) return null;
  return payload;
}

const list = (s) => String(s || "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

// 戻り値: { email, admin } または Response（拒否）
export async function authenticate(request, env) {
  if (env.DEV_BYPASS_AUTH === "1") return { email: "dev@localhost", admin: true };
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return json({ error: "access_not_configured" }, 503);
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  if (!token) return json({ error: "unauthorized" }, 401);
  let payload = null;
  try {
    payload = await verifyAccessJWT(token, team, aud);
  } catch (e) {
    return json({ error: "auth_check_failed" }, 503);
  }
  const email = String(payload?.email || "").toLowerCase();
  if (!email) return json({ error: "unauthorized" }, 401);
  const allowed = list(env.ALLOWED_EMAILS);
  const admins = list(env.ADMIN_EMAILS);
  if (!allowed.includes(email) && !admins.includes(email)) return json({ error: "forbidden" }, 403);
  return { email, admin: admins.includes(email) };
}

function cookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
