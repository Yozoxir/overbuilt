const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT NOT NULL,
    discord_avatar TEXT,
    access_token TEXT,
    role TEXT DEFAULT 'pending',
    status TEXT DEFAULT 'active',
    admin_note TEXT DEFAULT '',
    onboarded INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS onboarding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT,
    prenom TEXT, nom TEXT,
    phone TEXT, email TEXT,
    objectif TEXT,
    experience TEXT,
    budget TEXT,
    disponibilite TEXT,
    niche TEXT,
    tiktok_handle TEXT,
    instagram_handle TEXT,
    youtube_handle TEXT,
    motivation TEXT,
    completed_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS social_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, platform, handle)
  );

  CREATE TABLE IF NOT EXISTS social_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    followers INTEGER DEFAULT 0,
    following INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    videos INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    fetched_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES social_accounts(id)
  );

  CREATE TABLE IF NOT EXISTS formation_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS formation_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    video_type TEXT DEFAULT 'youtube',
    duration_minutes INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (module_id) REFERENCES formation_modules(id)
  );

  CREATE TABLE IF NOT EXISTS formation_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chapter_id INTEGER NOT NULL,
    completed_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, chapter_id)
  );

  CREATE TABLE IF NOT EXISTS daily_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    theory_title TEXT NOT NULL,
    theory_content TEXT NOT NULL,
    action_title TEXT NOT NULL,
    action_content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    content TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration INTEGER DEFAULT 30,
    topic TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    notif_sent INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS available_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration INTEGER DEFAULT 30,
    booked INTEGER DEFAULT 0,
    UNIQUE(date, time)
  );

  CREATE TABLE IF NOT EXISTS time_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    discord_username TEXT,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    content TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, date, slot)
  );

  CREATE TABLE IF NOT EXISTS dm_channels (
    discord_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS module_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id INTEGER NOT NULL UNIQUE,
    data BLOB NOT NULL,
    mime_type TEXT DEFAULT 'image/jpeg'
  );

  CREATE TABLE IF NOT EXISTS dashboard_layout (
    user_id TEXT PRIMARY KEY,
    layout TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manual_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    followers INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    videos INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    submitted_at TEXT NOT NULL,
    UNIQUE(user_id, platform, submitted_at)
  );

  CREATE TABLE IF NOT EXISTS call_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    slot_duration INTEGER DEFAULT 30,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS onboarding_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_order INTEGER NOT NULL,
    step_key TEXT NOT NULL,
    step_title TEXT NOT NULL,
    step_type TEXT DEFAULT 'choice',
    options_json TEXT DEFAULT '[]',
    required INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1
  );
`);

// Migrations — ajout de colonnes manquantes
try { db.exec('ALTER TABLE calls ADD COLUMN status TEXT DEFAULT \'pending\''); } catch(e) {}
try { db.exec('ALTER TABLE calls ADD COLUMN notif_sent INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN admin_note TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN status TEXT DEFAULT \'active\''); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN onboarded INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN access_token TEXT'); } catch(e) {}

// Default admin settings
const defaults = [
  ['onboarding_enabled', '1'],
  ['onboarding_fields', JSON.stringify(['objectif','experience','disponibilite','niche','tiktok','instagram','youtube','motivation','prenom','nom','email','phone'])],
  ['features_enabled', JSON.stringify(['dashboard','daily','calls','formation','timeblocks'])],
  ['platform_name', 'OVERBUILT'],
  ['platform_tagline', 'Plateforme de coaching'],
  ['welcome_message', 'Bienvenue dans le programme. Connecte-toi avec Discord pour acceder a ton espace.'],
];
for (const [key, value] of defaults) {
  try { db.prepare('INSERT OR IGNORE INTO admin_settings (key, value) VALUES (?, ?)').run(key, value); } catch(e) {}
}

try { db.exec("ALTER TABLE available_slots ADD COLUMN is_recurring INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE available_slots ADD COLUMN recur_day INTEGER DEFAULT -1"); } catch(e) {}

// Default call settings if empty
var existingSettings = db.prepare('SELECT COUNT(*) as c FROM call_settings').get();
if (existingSettings.c === 0) {
  // Mon-Fri 9h-18h by default
  for (var day = 1; day <= 5; day++) {
    db.prepare('INSERT INTO call_settings (day_of_week, start_time, end_time, slot_duration) VALUES (?, ?, ?, ?)').run(day, '09:00', '18:00', 30);
  }
}

// Default admin settings
var settingsDefaults = [
  ['miro_url', ''],
  ['platform_name', 'OVERBUILT'],
  ['welcome_message', 'Bienvenue sur la plateforme'],
  ['calls_enabled', '1'],
  ['daily_reminder_enabled', '1'],
];
settingsDefaults.forEach(function(s) {
  try { db.prepare('INSERT OR IGNORE INTO admin_settings (key, value) VALUES (?, ?)').run(s[0], s[1]); } catch(e) {}
});

module.exports = db;
