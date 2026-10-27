// Cloudflare Access JWT verification (RS256) with WebCrypto, mirroring the
// eagle viewer: issuer, audience, expiry and the exact allowed email.

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

const cache = new Map(); // team URL -> { at, keys }
export async function accessKeys(teamUrl, fetcher = fetch) {
  const hit = cache.get(teamUrl);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetcher(`${teamUrl}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Access certs unavailable');
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cache.set(teamUrl, { at: Date.now(), keys });
  return keys;
}

export async function verifyAccessJwt(token, { teamUrl, audience, allowedEmail, getKeys = accessKeys, now = Date.now() }) {
  if (!token || !teamUrl || !audience) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = json(parts[0]);
    const payload = json(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = (await getKeys(teamUrl)).get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const secs = Math.floor(now / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== teamUrl || !aud.includes(audience)) return null;
    if (!Number.isFinite(payload.exp) || payload.exp < secs - 30) return null;
    if (Number.isFinite(payload.nbf) && payload.nbf > secs + 30) return null;
    if (!payload.sub || !Number.isFinite(payload.iat)) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (allowedEmail && email !== allowedEmail.trim().toLowerCase()) return null;
    return { email };
  } catch {
    return null;
  }
}
