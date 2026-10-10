import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8765);
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;
const SCOPES = process.env.TIKTOK_SCOPES || 'user.info.basic,user.info.profile,user.info.stats,video.list';
const configured = Boolean(CLIENT_KEY && CLIENT_SECRET);

const tokenFile = path.join(root, 'tokens.json');
let tokens = fs.existsSync(tokenFile) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')) : null;
const pendingStates = new Map();

function saveTokens(data) {
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    expires_at: Date.now() + (data.expires_in - 60) * 1000
  };
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
}

async function tokenRequest(params) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, ...params })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  return data;
}

async function accessToken() {
  if (!tokens) throw new Error('not connected');
  if (Date.now() >= tokens.expires_at) {
    saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
  }
  return tokens.access_token;
}

async function tiktok(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }
  });
  const body = await res.json();
  if (!res.ok || (body.error?.code && body.error.code !== 'ok')) {
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return body.data;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const redirect = (res, location) => {
  res.writeHead(302, { Location: location });
  res.end();
};

const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const publicFiles = new Set(['index.html', 'privacy.html', 'terms.html', 'tokdesk-icon.png']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (url.pathname === '/api/status') {
      return json(res, 200, { configured, connected: Boolean(tokens), redirectUri: REDIRECT_URI });
    }

    if (url.pathname === '/oauth/tiktok') {
      if (!configured) return redirect(res, '/?connection_error=not_configured');
      const state = crypto.randomBytes(16).toString('hex');
      pendingStates.set(state, Date.now());
      const auth = new URL('https://www.tiktok.com/v2/auth/authorize/');
      auth.search = new URLSearchParams({
        client_key: CLIENT_KEY,
        scope: SCOPES,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state
      }).toString();
      return redirect(res, auth.toString());
    }

    if (url.pathname === '/oauth/callback') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !pendingStates.delete(state) || !code) return redirect(res, '/?connection_error=1');
      saveTokens(await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }));
      return redirect(res, '/?connected=1');
    }

    if (url.pathname === '/api/profile') {
      const fields = 'open_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count';
      return json(res, 200, await tiktok(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`));
    }

    if (url.pathname === '/api/videos') {
      const fields = 'id,title,video_description,cover_image_url,share_url,create_time,duration,view_count,like_count,comment_count,share_count';
      const data = await tiktok(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
        method: 'POST',
        body: JSON.stringify({ max_count: 20 })
      });
      return json(res, 200, { videos: data.videos || [] });
    }

    if (url.pathname === '/api/disconnect' && req.method === 'POST') {
      tokens = null;
      fs.rmSync(tokenFile, { force: true });
      return json(res, 200, { ok: true });
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (publicFiles.has(name)) {
      res.writeHead(200, { 'Content-Type': mime[path.extname(name)] });
      return res.end(fs.readFileSync(path.join(root, name)));
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    console.error(url.pathname, error.message);
    json(res, 502, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TokDesk: http://127.0.0.1:${PORT}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  if (!configured) console.log('Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env');
});
