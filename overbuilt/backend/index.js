require('dotenv').config();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const db = require('./db');
const { scrapeAll, scrapeAccount } = require('./scraper');
const { sendDM, sendMessage, addMemberToGuild, kickMember } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'overbuilt-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  if (req.session.user.discord_id !== process.env.ADMIN_DISCORD_ID) return res.status(403).json({ error: 'Accès refusé' });
  next();
}

// ── DISCORD OAUTH ────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    const { id, username, avatar } = userRes.data;
    db.prepare(`INSERT INTO users (id, discord_id, discord_username, discord_avatar, access_token) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET discord_username=excluded.discord_username, discord_avatar=excluded.discord_avatar, access_token=excluded.access_token`)
      .run(id, id, username, avatar, access_token);
    req.session.user = { discord_id: id, discord_username: username, discord_avatar: avatar, access_token };
    req.session.save(() => {
      const isAdmin = id === process.env.ADMIN_DISCORD_ID;
      const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
      res.redirect('/?logged=1&admin=' + isAdmin + '&onboarded=' + (userRow?.onboarded || 0));
    });
  } catch(err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/auth/me', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(user.discord_id);
    const accounts = db.prepare('SELECT * FROM social_accounts WHERE user_id = ?').all(user.discord_id);
    const onboarding = db.prepare('SELECT * FROM onboarding WHERE discord_id = ?').get(user.discord_id);

    const accountsWithMetrics = accounts.map(acc => {
      const latest = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 1').get(acc.id);
      const week = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 7').all(acc.id);
      return { ...acc, latest: latest || null, history: week };
    });

    res.json({
      discord_id: user.discord_id,
      discord_username: user.discord_username,
      discord_avatar: user.discord_avatar,
      is_admin: user.discord_id === process.env.ADMIN_DISCORD_ID,
      is_member: userRow?.role === 'member',
      onboarded: userRow?.onboarded === 1,
      status: userRow?.status || 'active',
      social_accounts: accountsWithMetrics,
      onboarding,
    });
  } catch(err) {
    console.error('me error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ONBOARDING ────────────────────────────────────────────────
app.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { prenom, nom, phone, email, objectif, experience, budget, disponibilite, niche, tiktok_handle, instagram_handle, youtube_handle, motivation } = req.body;

    if (!prenom || !nom || !email) return res.status(400).json({ error: 'Champs obligatoires manquants' });

    db.prepare(`INSERT INTO onboarding (discord_id, discord_username, prenom, nom, phone, email, objectif, experience, budget, disponibilite, niche, tiktok_handle, instagram_handle, youtube_handle, motivation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET prenom=excluded.prenom, nom=excluded.nom, phone=excluded.phone, email=excluded.email, objectif=excluded.objectif, experience=excluded.experience, budget=excluded.budget, disponibilite=excluded.disponibilite, niche=excluded.niche, tiktok_handle=excluded.tiktok_handle, instagram_handle=excluded.instagram_handle, youtube_handle=excluded.youtube_handle, motivation=excluded.motivation`)
      .run(user.discord_id, user.discord_username, prenom, nom, phone || '', email, objectif || '', experience || '', budget || '', disponibilite || '', niche || '', tiktok_handle || '', instagram_handle || '', youtube_handle || '', motivation || '');

    db.prepare('UPDATE users SET onboarded = 1, role = "member" WHERE discord_id = ?').run(user.discord_id);

    // Auto-add social accounts
    const platforms = [
      { platform: 'tiktok', handle: tiktok_handle },
      { platform: 'instagram', handle: instagram_handle },
      { platform: 'youtube', handle: youtube_handle },
    ];
    for (const p of platforms) {
      if (p.handle && p.handle.trim()) {
        try {
          db.prepare('INSERT OR IGNORE INTO social_accounts (user_id, platform, handle) VALUES (?, ?, ?)').run(user.discord_id, p.platform, p.handle.trim());
        } catch(e) {}
      }
    }

    // Add to Discord server
    const userRow = db.prepare('SELECT access_token FROM users WHERE discord_id = ?').get(user.discord_id);
    await addMemberToGuild(user.discord_id, userRow?.access_token);

    // Welcome DM
    await sendDM(user.discord_id, "Bienvenue dans OVERBUILT " + prenom + " ! Ton onboarding est complet. Tu as maintenant accès à la plateforme de coaching. Prêt à passer au niveau supérieur ?");

    if (process.env.DISCORD_NOTIF_CHANNEL) {
      sendMessage(process.env.DISCORD_NOTIF_CHANNEL, "Nouveau membre OVERBUILT : **" + user.discord_username + "** (" + prenom + " " + nom + ") vient de compléter son onboarding !");
    }

    // Trigger scrape for new accounts
    setTimeout(() => scrapeAll().catch(console.error), 2000);

    res.json({ ok: true });
  } catch(err) {
    console.error('onboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── COMPTES SOCIAUX ───────────────────────────────────────────
app.get('/accounts', requireAuth, (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts WHERE user_id = ?').all(req.session.user.discord_id);
    const result = accounts.map(acc => {
      const latest = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 1').get(acc.id);
      const history = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 7').all(acc.id);
      return { ...acc, latest, history };
    });
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/accounts', requireAuth, (req, res) => {
  try {
    const { platform, handle } = req.body;
    if (!platform || !handle) return res.status(400).json({ error: 'Requis' });
    const clean = handle.trim().replace('@', '');
    db.prepare('INSERT INTO social_accounts (user_id, platform, handle) VALUES (?, ?, ?)').run(req.session.user.discord_id, platform, '@' + clean);
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Déjà ajouté' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/accounts/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM social_accounts WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.discord_id);
    db.prepare('DELETE FROM social_metrics WHERE account_id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/accounts/:id/refresh', requireAuth, async (req, res) => {
  try {
    const acc = db.prepare('SELECT * FROM social_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.discord_id);
    if (!acc) return res.status(404).json({ error: 'Compte introuvable' });
    await scrapeAccount(acc.id, acc.platform, acc.handle);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── FORMATIONS ────────────────────────────────────────────────
app.get('/formations', requireAuth, (req, res) => {
  try {
    const modules = db.prepare('SELECT * FROM formation_modules ORDER BY position ASC').all();
    const result = modules.map(m => {
      const chapters = db.prepare('SELECT * FROM formation_chapters WHERE module_id = ? ORDER BY position ASC').all(m.id);
      const progress = db.prepare('SELECT chapter_id FROM formation_progress WHERE user_id = ?').all(req.session.user.discord_id);
      const completedIds = new Set(progress.map(p => p.chapter_id));
      const chaptersWithProgress = chapters.map(ch => ({ ...ch, completed: completedIds.has(ch.id) }));
      const completedCount = chaptersWithProgress.filter(ch => ch.completed).length;
      return { ...m, chapters: chaptersWithProgress, total_chapters: chapters.length, completed_chapters: completedCount, progress_pct: chapters.length > 0 ? Math.round((completedCount / chapters.length) * 100) : 0 };
    });
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/formations/progress/:chapterId', requireAuth, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO formation_progress (user_id, chapter_id) VALUES (?, ?)').run(req.session.user.discord_id, req.params.chapterId);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/formations/progress/:chapterId', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_progress WHERE user_id = ? AND chapter_id = ?').run(req.session.user.discord_id, req.params.chapterId);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/formations/modules', requireAdmin, (req, res) => {
  try {
    const { title, description, cover_url } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM formation_modules').get();
    const result = db.prepare('INSERT INTO formation_modules (title, description, cover_url, position) VALUES (?, ?, ?, ?)').run(title, description || '', cover_url || '', (maxPos.m || 0) + 1);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/admin/formations/modules/:id', requireAdmin, (req, res) => {
  try {
    const { title, description, cover_url } = req.body;
    if (title !== undefined) db.prepare('UPDATE formation_modules SET title = ? WHERE id = ?').run(title, req.params.id);
    if (description !== undefined) db.prepare('UPDATE formation_modules SET description = ? WHERE id = ?').run(description, req.params.id);
    if (cover_url !== undefined) db.prepare('UPDATE formation_modules SET cover_url = ? WHERE id = ?').run(cover_url, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/formations/modules/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_chapters WHERE module_id = ?').run(req.params.id);
    db.prepare('DELETE FROM formation_modules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/formations/modules/:moduleId/chapters', requireAdmin, (req, res) => {
  try {
    const { title, description, video_url, video_type, duration_minutes } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM formation_chapters WHERE module_id = ?').get(req.params.moduleId);
    db.prepare('INSERT INTO formation_chapters (module_id, title, description, video_url, video_type, duration_minutes, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.params.moduleId, title, description || '', video_url || '', video_type || 'youtube', duration_minutes || 0, (maxPos.m || 0) + 1);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/admin/formations/chapters/:id', requireAdmin, (req, res) => {
  try {
    const { title, description, video_url, video_type, duration_minutes } = req.body;
    if (title !== undefined) db.prepare('UPDATE formation_chapters SET title = ? WHERE id = ?').run(title, req.params.id);
    if (description !== undefined) db.prepare('UPDATE formation_chapters SET description = ? WHERE id = ?').run(description, req.params.id);
    if (video_url !== undefined) db.prepare('UPDATE formation_chapters SET video_url = ? WHERE id = ?').run(video_url, req.params.id);
    if (video_type !== undefined) db.prepare('UPDATE formation_chapters SET video_type = ? WHERE id = ?').run(video_type, req.params.id);
    if (duration_minutes !== undefined) db.prepare('UPDATE formation_chapters SET duration_minutes = ? WHERE id = ?').run(duration_minutes, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/formations/chapters/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_progress WHERE chapter_id = ?').run(req.params.id);
    db.prepare('DELETE FROM formation_chapters WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN DASHBOARD ──────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  try {
    const members = db.prepare('SELECT * FROM users WHERE role = ?').all('member');
    const result = members.map(u => {
      const accounts = db.prepare('SELECT * FROM social_accounts WHERE user_id = ?').all(u.discord_id);
      const accountsWithMetrics = accounts.map(acc => {
        const latest = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 1').get(acc.id);
        const history = db.prepare('SELECT * FROM social_metrics WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 7').all(acc.id);
        return { ...acc, latest, history };
      });
      const onboarding = db.prepare('SELECT * FROM onboarding WHERE discord_id = ?').get(u.discord_id);
      const totalChapters = db.prepare('SELECT COUNT(*) as c FROM formation_chapters').get().c;
      const completedChapters = db.prepare('SELECT COUNT(*) as c FROM formation_progress WHERE user_id = ?').get(u.discord_id).c;
      return {
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        discord_avatar: u.discord_avatar,
        status: u.status,
        admin_note: u.admin_note || '',
        social_accounts: accountsWithMetrics,
        onboarding,
        formation_pct: totalChapters > 0 ? Math.round((completedChapters / totalChapters) * 100) : 0,
      };
    });
    res.json(result);
  } catch(err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/onboardings', requireAdmin, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM onboarding ORDER BY completed_at DESC').all());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/admin/members/:id', requireAdmin, (req, res) => {
  try {
    const { admin_note, status } = req.body;
    if (admin_note !== undefined) db.prepare('UPDATE users SET admin_note = ? WHERE discord_id = ?').run(admin_note, req.params.id);
    if (status !== undefined) db.prepare('UPDATE users SET status = ? WHERE discord_id = ?').run(status, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/members/:id/kick', requireAdmin, async (req, res) => {
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(req.params.id);
    if (!userRow) return res.status(404).json({ error: 'Introuvable' });
    db.prepare('UPDATE users SET role = ?, status = ? WHERE discord_id = ?').run('pending', 'active', req.params.id);
    db.prepare('DELETE FROM social_accounts WHERE user_id = ?').run(req.params.id);
    await sendDM(req.params.id, "Tu as été retiré(e) du programme OVERBUILT. Tes accès ont été révoqués.");
    await kickMember(req.params.id);
    if (process.env.DISCORD_NOTIF_CHANNEL) sendMessage(process.env.DISCORD_NOTIF_CHANNEL, "🚫 **" + userRow.discord_username + "** a été retiré(e) du programme OVERBUILT.");
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/members/:id/message', requireAdmin, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Vide' });
    const sent = await sendDM(req.params.id, "Message de OVERBUILT :\n" + content);
    res.json({ ok: sent });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/scrape', requireAdmin, (req, res) => {
  scrapeAll().catch(console.error);
  res.json({ ok: true });
});

// SSE temps réel
app.get('/admin/live-feed', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = () => {
    try {
      const members = db.prepare('SELECT discord_id, discord_username FROM users WHERE role = ?').all('member');
      const data = members.map(u => {
        const accounts = db.prepare('SELECT * FROM social_accounts WHERE user_id = ?').all(u.discord_id);
        return { discord_id: u.discord_id, account_count: accounts.length };
      });
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch(e) {}
  };
  send();
  const interval = setInterval(send, 15000);
  req.on('close', () => clearInterval(interval));
});


// ── CONTENU QUOTIDIEN (Hormozi) ──────────────────────────────
app.get('/daily', requireAuth, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const content = db.prepare('SELECT * FROM daily_content WHERE date = ?').get(today);
    const todos = db.prepare('SELECT * FROM todos WHERE user_id = ? AND date = ? ORDER BY position ASC').all(req.session.user.discord_id, today);
    res.json({ content: content || null, todos, date: today });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Todos
app.post('/todos', requireAuth, (req, res) => {
  try {
    const { content, date } = req.body;
    if (!content) return res.status(400).json({ error: 'Vide' });
    const d = date || new Date().toISOString().split('T')[0];
    const maxPos = db.prepare('SELECT MAX(position) as m FROM todos WHERE user_id = ? AND date = ?').get(req.session.user.discord_id, d);
    db.prepare('INSERT INTO todos (user_id, date, content, position) VALUES (?, ?, ?, ?)').run(req.session.user.discord_id, d, content, (maxPos.m || 0) + 1);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/todos/:id', requireAuth, (req, res) => {
  try {
    const { completed, content } = req.body;
    if (completed !== undefined) db.prepare('UPDATE todos SET completed = ? WHERE id = ? AND user_id = ?').run(completed ? 1 : 0, req.params.id, req.session.user.discord_id);
    if (content !== undefined) db.prepare('UPDATE todos SET content = ? WHERE id = ? AND user_id = ?').run(content, req.params.id, req.session.user.discord_id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/todos/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.discord_id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin — gérer le contenu quotidien
app.post('/admin/daily', requireAdmin, (req, res) => {
  try {
    const { date, theory_title, theory_content, action_title, action_content } = req.body;
    if (!date || !theory_title || !theory_content || !action_title || !action_content) return res.status(400).json({ error: 'Tous les champs requis' });
    db.prepare('INSERT INTO daily_content (date, theory_title, theory_content, action_title, action_content) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET theory_title=excluded.theory_title, theory_content=excluded.theory_content, action_title=excluded.action_title, action_content=excluded.action_content')
      .run(date, theory_title, theory_content, action_title, action_content);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/daily', requireAdmin, (req, res) => {
  try {
    const contents = db.prepare('SELECT * FROM daily_content ORDER BY date DESC LIMIT 30').all();
    res.json(contents);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/daily/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM daily_content WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── CALENDRIER CALLS ──────────────────────────────────────────

// Créneux disponibles
app.get('/slots', requireAuth, (req, res) => {
  try {
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const slots = db.prepare('SELECT * FROM available_slots WHERE date >= ? AND booked = 0 ORDER BY date ASC, time ASC').all(from || today);
    res.json(slots);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Réserver un call
app.post('/calls', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { slot_id, topic } = req.body;
    const slot = db.prepare('SELECT * FROM available_slots WHERE id = ? AND booked = 0').get(slot_id);
    if (!slot) return res.status(400).json({ error: 'Créneau indisponible' });

    // Vérifie pas déjà un call ce jour
    const existing = db.prepare('SELECT * FROM calls WHERE user_id = ? AND date = ? AND status != ?').get(user.discord_id, slot.date, 'cancelled');
    if (existing) return res.status(409).json({ error: 'Tu as déjà un call ce jour' });

    db.prepare('INSERT INTO calls (user_id, discord_username, date, time, duration, topic) VALUES (?, ?, ?, ?, ?, ?)').run(user.discord_id, user.discord_username, slot.date, slot.time, slot.duration, topic || '');
    db.prepare('UPDATE available_slots SET booked = 1 WHERE id = ?').run(slot_id);

    // Notif Discord admin
    if (process.env.DISCORD_NOTIF_CHANNEL) {
      const onb = db.prepare('SELECT prenom, nom FROM onboarding WHERE discord_id = ?').get(user.discord_id);
      const name = onb ? onb.prenom + ' ' + onb.nom : user.discord_username;
      sendMessage(process.env.DISCORD_NOTIF_CHANNEL, 'Nouveau call reserve - ' + name + ' - ' + slot.date + ' a ' + slot.time + ' (' + slot.duration + ' min) - Sujet: ' + (topic || 'Non precise'));
    }

    // DM de confirmation au membre
    await sendDM(user.discord_id, 'Ton call est confirme ! Date : ' + slot.date + ' a ' + slot.time + ' (' + slot.duration + ' min). Tu recevras un rappel 15 min avant.');

    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Mes calls
app.get('/calls', requireAuth, (req, res) => {
  try {
    const calls = db.prepare('SELECT * FROM calls WHERE user_id = ? ORDER BY date DESC, time DESC').all(req.session.user.discord_id);
    res.json(calls);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Annuler un call
app.delete('/calls/:id', requireAuth, async (req, res) => {
  try {
    const call = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.discord_id);
    if (!call) return res.status(404).json({ error: 'Introuvable' });
    db.prepare('UPDATE calls SET status = "cancelled" WHERE id = ?').run(req.params.id);
    db.prepare('UPDATE available_slots SET booked = 0 WHERE date = ? AND time = ?').run(call.date, call.time);
    if (process.env.DISCORD_NOTIF_CHANNEL) sendMessage(process.env.DISCORD_NOTIF_CHANNEL, '❌ Call annulé par **' + call.discord_username + '** (' + call.date + ' ' + call.time + ')');
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin — tous les calls
app.get('/admin/calls', requireAdmin, (req, res) => {
  try {
    const calls = db.prepare('SELECT * FROM calls WHERE status != ? ORDER BY date ASC, time ASC').all('cancelled');
    res.json(calls);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin — gérer les créneaux
app.post('/admin/slots', requireAdmin, (req, res) => {
  try {
    const { date, time, duration } = req.body;
    if (!date || !time) return res.status(400).json({ error: 'Date et heure requis' });
    db.prepare('INSERT OR IGNORE INTO available_slots (date, time, duration) VALUES (?, ?, ?)').run(date, time, duration || 30);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/slots/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM available_slots WHERE id = ? AND booked = 0').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── TIME BLOCKS (Hormozi 30min) ──────────────────────────────

// Récupère les time blocks du jour pour un membre
app.get('/timeblocks', requireAuth, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const blocks = db.prepare('SELECT * FROM time_blocks WHERE user_id = ? AND date = ? ORDER BY slot ASC').all(req.session.user.discord_id, today);
    res.json(blocks);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin — voir tous les time blocks du jour
app.get('/admin/timeblocks', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const members = db.prepare('SELECT * FROM users WHERE role = ?').all('member');
    const result = members.map(u => {
      const blocks = db.prepare('SELECT * FROM time_blocks WHERE user_id = ? AND date = ? ORDER BY slot ASC').all(u.discord_id, today);
      const filled = blocks.filter(b => b.content && b.content.trim().length > 0).length;
      return {
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        discord_avatar: u.discord_avatar,
        blocks,
        filled_count: filled,
        total_count: blocks.length,
      };
    });
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── ADMIN SETTINGS ────────────────────────────────────────────
app.get('/admin/settings', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM admin_settings').all();
    const settings = {};
    rows.forEach(r => { try { settings[r.key] = JSON.parse(r.value); } catch(e) { settings[r.key] = r.value; } });
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/admin/settings', requireAdmin, (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM admin_settings').all();
    const settings = {};
    rows.forEach(r => { try { settings[r.key] = JSON.parse(r.value); } catch(e) { settings[r.key] = r.value; } });
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── IMAGE UPLOAD MODULES ──────────────────────────────────
app.post('/admin/formations/modules/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    db.prepare('DELETE FROM module_images WHERE module_id = ?').run(req.params.id);
    db.prepare('INSERT INTO module_images (module_id, filename, data, mime_type) VALUES (?, ?, ?, ?)').run(req.params.id, req.file.originalname, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, url: '/api/module-image/' + req.params.id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/module-image/:id', (req, res) => {
  try {
    const img = db.prepare('SELECT * FROM module_images WHERE module_id = ?').get(req.params.id);
    if (!img) return res.status(404).send('Not found');
    res.setHeader('Content-Type', img.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(img.data);
  } catch(err) { res.status(500).send('Error'); }
});

// ── DASHBOARD LAYOUT ──────────────────────────────────────
app.get('/layout', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT layout FROM dashboard_layout WHERE user_id = ?').get(req.session.user.discord_id);
    res.json({ layout: row ? JSON.parse(row.layout) : null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/layout', requireAuth, (req, res) => {
  try {
    const { layout } = req.body;
    db.prepare('INSERT INTO dashboard_layout (user_id, layout) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET layout=excluded.layout, updated_at=unixepoch()').run(req.session.user.discord_id, JSON.stringify(layout));
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── COMPTE MEMBRE (éditer onboarding) ────────────────────
app.get('/account', requireAuth, (req, res) => {
  try {
    const ob = db.prepare('SELECT * FROM onboarding WHERE discord_id = ?').get(req.session.user.discord_id);
    res.json(ob || null);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/account', requireAuth, (req, res) => {
  try {
    const fields = ['prenom','nom','phone','email','objectif','experience','disponibilite','niche','tiktok_handle','instagram_handle','youtube_handle','motivation'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(f + ' = ?');
        values.push(req.body[f]);
      }
    });
    if (!updates.length) return res.json({ ok: true });
    values.push(req.session.user.discord_id);
    db.prepare('UPDATE onboarding SET ' + updates.join(', ') + ' WHERE discord_id = ?').run(...values);

    // Sync social accounts
    const handles = [
      { platform: 'tiktok', handle: req.body.tiktok_handle },
      { platform: 'instagram', handle: req.body.instagram_handle },
      { platform: 'youtube', handle: req.body.youtube_handle },
    ];
    for (const h of handles) {
      if (h.handle !== undefined) {
        if (h.handle && h.handle.trim()) {
          try { db.prepare('INSERT OR IGNORE INTO social_accounts (user_id, platform, handle) VALUES (?, ?, ?)').run(req.session.user.discord_id, h.platform, h.handle.trim()); } catch(e) {}
        }
      }
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));


// Check DM replies pour time blocks
async function checkTimeBlockReplies() {
  const today = new Date().toISOString().split('T')[0];
  const members = db.prepare('SELECT * FROM users WHERE role = ?').all('member');
  for (const user of members) {
    const channelId = await getDMChannel(user.discord_id);
    if (!channelId) continue;
    try {
      const res = await axios.get('https://discord.com/api/v10/channels/' + channelId + '/messages?limit=5', { headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN } });
      const msgs = res.data;
      for (const msg of msgs) {
        if (msg.author.id !== user.discord_id) continue;
        const msgDate = new Date(msg.timestamp).toISOString().split('T')[0];
        if (msgDate !== today) break;
        // Cherche un time block vide recent
        const emptyBlock = db.prepare('SELECT * FROM time_blocks WHERE user_id = ? AND date = ? AND (content IS NULL OR content = "") ORDER BY slot DESC LIMIT 1').get(user.discord_id, today);
        if (emptyBlock) {
          db.prepare('UPDATE time_blocks SET content = ? WHERE id = ?').run(msg.content, emptyBlock.id);
          console.log('[TIME BLOCK] Reponse enregistree pour', user.discord_username, emptyBlock.slot);
        }
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch(e) {}
  }
}

// Check calls à venir — rappel 15min avant
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().slice(0,5);
    // Rappel 15 min avant
    const in15 = new Date(now.getTime() + 15 * 60 * 1000);
    const remind15Time = in15.toTimeString().slice(0,5);
    const calls = db.prepare('SELECT * FROM calls WHERE date = ? AND time = ? AND status = ? AND notif_sent = 0').all(today, remind15Time, 'pending');
    for (const call of calls) {
      if (process.env.DISCORD_NOTIF_CHANNEL) {
        sendMessage(process.env.DISCORD_NOTIF_CHANNEL, '⏰ **Call dans 15 minutes !**\nMembre : **' + call.discord_username + '**\nHeure : ' + call.time + '\nSujet : ' + (call.topic || 'Non précisé'));
      }
      sendDM(call.user_id, '⏰ Rappel : ton call avec moi commence dans **15 minutes** (' + call.time + '). Sois prêt(e) !');
      db.prepare('UPDATE calls SET notif_sent = 1 WHERE id = ?').run(call.id);
    }
  } catch(e) { console.error('Cron calls error:', e.message); }
});


// Toutes les 30 min — relance les membres pour qu'ils écrivent leur bilan
cron.schedule('*/30 * * * *', async () => {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hours = now.getHours();
    const minutes = now.getMinutes();
    // Seulement entre 8h et 22h
    if (hours < 8 || hours >= 22) return;
    const slotLabel = hours + 'h' + (minutes === 0 ? '00' : '30');
    const members = db.prepare('SELECT * FROM users WHERE role = ? AND status = ?').all('member', 'active');
    for (const user of members) {
      // Vérifie pas déjà répondu pour ce slot
      const existing = db.prepare('SELECT * FROM time_blocks WHERE user_id = ? AND date = ? AND slot = ?').get(user.discord_id, today, slotLabel);
      if (existing && existing.content) continue;
      // Crée le slot vide
      try { db.prepare('INSERT OR IGNORE INTO time_blocks (user_id, discord_username, date, slot) VALUES (?, ?, ?, ?)').run(user.discord_id, user.discord_username, today, slotLabel); } catch(e) {}
      // Envoie le DM
      await sendDM(user.discord_id, 'Il est ' + slotLabel + ' - Qu\'est-ce que tu as fait ces 30 dernieres minutes ? Reponds a ce message pour enregistrer ton bilan.');
      await new Promise(r => setTimeout(r, 400));
    }
  } catch(e) { console.error('Cron 30min error:', e.message); }
});

// A 22h — recap quotidien de la journee envoye a chaque membre
cron.schedule('0 22 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const members = db.prepare('SELECT * FROM users WHERE role = ? AND status = ?').all('member', 'active');
    for (const user of members) {
      const blocks = db.prepare('SELECT * FROM time_blocks WHERE user_id = ? AND date = ? AND content != "" ORDER BY slot ASC').all(user.discord_id, today);
      if (!blocks.length) {
        await sendDM(user.discord_id, 'Recap de ta journee du ' + today + ' : Aucun bilan enregistre aujourd\'hui. Demain on repart fort !');
        continue;
      }
      var recap = 'Recap de ta journee du ' + today + ' :\n\n';
      blocks.forEach(function(b) { recap += b.slot + ' : ' + b.content + '\n'; });
      recap += '\nTotal : ' + blocks.length + ' blocs de 30min documentes. Continue comme ca !';
      await sendDM(user.discord_id, recap);
      await new Promise(r => setTimeout(r, 400));
    }
  } catch(e) { console.error('Cron recap error:', e.message); }
});

// Scrape toutes les 6h
cron.schedule('0 */6 * * *', () => scrapeAll().catch(console.error));
cron.schedule('*/10 * * * *', () => checkTimeBlockReplies().catch(console.error));

app.listen(PORT, () => {
  console.log('OVERBUILT — port ' + PORT);
  setTimeout(() => scrapeAll().catch(console.error), 5000);
});
