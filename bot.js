/**
 * VERITY AI — vrai bot Discord (backend a deployer hors Perchance)
 * ------------------------------------------------------------------
 * Ce que fait ce fichier :
 *  - se connecte a Discord en Gateway (lit les messages, detecte les mentions @Verity)
 *  - "@Verity reset" efface la conversation de CET utilisateur AVANT tout appel IA
 *  - "@Verity forget everything" / "oublie tout" efface ses souvenirs long terme (cet user uniquement)
 *  - memoire persistante : SQLite (./verity.sqlite) ou Postgres si DATABASE_URL est defini
 *  - appelle une API IA OpenAI-compatible, repond dans le salon d'origine (limite 2000 car.)
 *  - expose un mini endpoint HTTP GET /status pour le tableau de bord Perchance
 *
 * Installation : voir README-DEPLOY.md dans le meme dossier.
 * SECURITE : ce fichier est PUBLIC (source Perchance). Ne mets AUCUN secret ici.
 *            Les secrets vont dans `.env` (jamais committe) ou les variables Render.
 */
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ---------- constantes d'identite (doivent matcher le panneau Perchance) ----------
const FIRST_GREETING = "Hello, i am verity, your personal helper friend ask me anything i know everything.";
const RESET_CONFIRM = "Conversation réinitialisée ! Hello again, I'm Verity. De quoi veux-tu parler ?";
const WIPE_CONFIRM = "Mes souvenirs à long terme te concernant ont été complètement effacés. On repart de zéro ! 🌱";
const DEFAULT_SYSTEM = `Tu es Verity, une assistante personnelle amicale, curieuse, serviable et naturelle, inspirée de l'assistant Verity de Minecraft.
- Tu réponds dans la langue de ton interlocuteur.
- Tu peux parler de Minecraft, jeux vidéo, programmation, sciences, tech et culture générale, et expliquer simplement les sujets complexes.
- Tu te souviens du contexte récent et des souvenirs fournis (ne les invente jamais).
- Tu reconnais honnêtement tes limites quand tu ne sais pas.
- Tu ne répètes jamais ta présentation sauf première rencontre ou demande explicite.
- Style chaleureux, concis, touche ludique Minecraft modérée. Réponses <= 1900 caractères.`;
const SECRET_RE = /(password|mot de passe|api[_-]?key|clef?\s*api|secret|token|discord\.com\/api\/webhooks|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{10,}|xox[bap]-)/i;

const CFG = {
  token: process.env.DISCORD_TOKEN || "",
  allowed: (process.env.ALLOWED_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean),
  webhook: process.env.WEBHOOK_URL || "",
  botName: process.env.BOT_NAME || "Verity",
  avatarUrl: process.env.AVATAR_URL || "",
  aiBase: (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  aiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "gpt-4o-mini",
  aiTemp: parseFloat(process.env.AI_TEMPERATURE || "0.7"),
  aiMax: Math.max(50, Math.min(4000, parseInt(process.env.AI_MAX_CHARS || "1500", 10))),
  aiSystem: process.env.AI_SYSTEM || DEFAULT_SYSTEM,
  dbFile: process.env.MEMORY_DB || "./verity.sqlite",
  pgUrl: process.env.DATABASE_URL || "",
  retentionDays: parseInt(process.env.RETENTION_DAYS || "90", 10),
  ignoreBots: (process.env.IGNORE_BOTS || "true") !== "false",
  autoMode: (process.env.AUTO_MODE || "false") === "true",
  port: parseInt(process.env.PORT || "3000", 10),
};

// ---------- couche memoire : Postgres si DATABASE_URL, sinon SQLite, sinon JSON ----------
let store;
if (CFG.pgUrl) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: CFG.pgUrl });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS verity_kv (k TEXT PRIMARY KEY, v TEXT)`);
    },
    async get(k, d) { const r = await pool.query("SELECT v FROM verity_kv WHERE k=$1", [k]); return r.rows.length ? JSON.parse(r.rows[0].v) : d; },
    async set(k, v) { await pool.query("INSERT INTO verity_kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2", [k, JSON.stringify(v)]); },
    async del(k) { await pool.query("DELETE FROM verity_kv WHERE k=$1", [k]); },
  };
  console.log("[verity] mémoire : Postgres");
} else {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(CFG.dbFile);
    db.exec("CREATE TABLE IF NOT EXISTS verity_kv (k TEXT PRIMARY KEY, v TEXT)");
    const g = db.prepare("SELECT v FROM verity_kv WHERE k=?");
    const s = db.prepare("INSERT INTO verity_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
    const d = db.prepare("DELETE FROM verity_kv WHERE k=?");
    store = {
      async init() {},
      async get(k, def) { const r = g.get(k); return r ? JSON.parse(r.v) : def; },
      async set(k, v) { s.run(k, JSON.stringify(v)); },
      async del(k) { d.run(k); },
    };
    console.log("[verity] mémoire : SQLite (" + CFG.dbFile + ")");
  } catch (e) {
    console.warn("[verity] SQLite indisponible, repli JSON local :", e.message);
    const file = path.join(__dirname, "verity-memory.json");
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    const save = () => fs.writeFileSync(file, JSON.stringify(cache));
    store = {
      async init() {},
      async get(k, dflt) { return k in cache ? cache[k] : dflt; },
      async set(k, v) { cache[k] = v; save(); },
      async del(k) { delete cache[k]; save(); },
    };
  }
}

const seenMsgIds = new Set();
let stats = { processed: 0, sent: 0, mentions: 0, errors: [] };

function isResetCommand(t) { return /(?:@verity|verity)\s+reset\b/i.test(t || "") || /^\s*reset\s*$/i.test(t || ""); }
function isWipeCommand(t) {
  return /(?:@verity|verity)\s+(forget|wipe|oublie|efface).*(everything|tout|memoire|mémoire|all)?/i.test(t || "") ||
    /(oublie tout|efface (tout|mes souvenirs)|forget everything|wipe (my )?memory)/i.test(t || "");
}
function isMentioned(msg) {
  if (msg.mentions && msg.mentions.has(client.user)) return true;
  const t = msg.content || "";
  if (/^\s*[/!]\s*verity\b/i.test(t)) return true; // préfixe texte : "/verity", "!verity", "! verity"…
  return /@verity|\bverity\b/i.test(t);
}
function stripMention(t) {
  return String(t || "").replace(/<@!?\d+>/g, "").replace(/<@&?\d+>/g, "").replace(/@verity/gi, "").replace(/^\s*[/!]\s*verity\b/i, "").replace(/^\s*[/!]\s*/, "").replace(/\bverity\b/gi, "").trim().replace(/^[:,.\-–—\s]+/, "");
}
function score(question, text) {
  const q = new Set(String(question).toLowerCase().split(/[^a-zàâäéèêëîïôöùûüç0-9]+/i).filter(w => w.length > 2));
  let s = 0;
  for (const w of String(text).toLowerCase().split(/[^a-zàâäéèêëîïôöùûüç0-9]+/i)) if (q.has(w)) s += w.length > 5 ? 2 : 1;
  return s;
}
const trunc = (s) => { s = String(s || ""); return s.length <= 2000 ? s : s.slice(0, 1990) + "…"; };

async function relevantMemories(uid, question, n) {
  const all = await store.get("long_" + uid, []);
  return all.map(m => ({ m, s: score(question, m.text) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n || 3).map(x => x.m);
}

async function callAI(question, uid) {
  if (!CFG.aiKey) throw new Error("AI_API_KEY manquante côté serveur.");
  const short = await store.get("short_" + uid, []);
  const mems = await relevantMemories(uid, question, 3);
  const shared = await store.get("shared_server", []);
  let sys = CFG.aiSystem + "\nRéponds dans la langue du dernier message. Max " + CFG.aiMax + " caractères.";
  if (mems.length) sys += "\nSouvenirs de cet utilisateur (si pertinent) :\n" + mems.map(m => "- " + m.text).join("\n");
  if (shared.length) sys += "\nInfos serveur :\n" + shared.map(m => "- " + m.text).join("\n");
  if (short.length) sys += "\nContexte récent :\n" + short.slice(-8).map(h => (h.role === "user" ? "U: " : "V: ") + h.content).join("\n");
  const r = await fetch(CFG.aiBase + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.aiKey },
    body: JSON.stringify({ model: CFG.aiModel, messages: [{ role: "system", content: sys }, { role: "user", content: question }], temperature: CFG.aiTemp }),
  });
  if (!r.ok) throw new Error("IA HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const out = (j.choices?.[0]?.message?.content || "").trim();
  if (!out) throw new Error("Réponse IA vide.");
  return out.slice(0, CFG.aiMax);
}

async function handleMessage(msg) {
  stats.processed++;
  const uid = msg.author.id, uname = msg.author.username;
  const text = msg.content || "";
  // anti-doublon (même ID déjà traité, ex. redémarrage / double event)
  if (seenMsgIds.has(msg.id)) return;
  seenMsgIds.add(msg.id);
  if (seenMsgIds.size > 500) seenMsgIds.clear();

  // 1) reset AVANT l'IA, per-user uniquement, jamais le serveur entier
  if (isResetCommand(text)) {
    await store.set("short_" + uid, []);
    await msg.reply(RESET_CONFIRM);
    stats.sent++;
    console.log("[verity] reset conversation de " + uname);
    return;
  }
  // 2) wipe long terme (commande distincte, explicite)
  if (isWipeCommand(text)) {
    await store.set("long_" + uid, []);
    await msg.reply(WIPE_CONFIRM);
    stats.sent++;
    console.log("[verity] wipe souvenirs de " + uname);
    return;
  }
  // 3) contexte + auto-mémoire (refuse les secrets, sans jamais prétendre avoir sauvé)
  const short = await store.get("short_" + uid, []);
  short.push({ role: "user", content: text.slice(0, 1000), ts: new Date().toISOString() });
  while (short.length > 20) short.shift();
  await store.set("short_" + uid, short);
  const m = text.match(/(?:souviens-toi que|retiens que|remember that|n'oublie pas que)\s*[:\-]?\s*(.+)/i);
  if (m && !SECRET_RE.test(m[1])) {
    const arr = await store.get("long_" + uid, []);
    const fact = m[1].trim().slice(0, 300);
    if (fact && !arr.some(x => x.text === fact)) { arr.push({ id: "m" + Date.now(), text: fact, ts: new Date().toISOString() }); await store.set("long_" + uid, arr); }
  }
  // 4) IA avec souvenirs + contexte
  const seen = await store.get("seen", {});
  const first = !seen[uid];
  await msg.reply("✅ Message reçu !"); // accusé immédiat, la réponse suit
  let answer;
  try {
    answer = await callAI(stripMention(text) || text, uid);
  } catch (e) {
    stats.errors.unshift({ ts: new Date().toISOString(), err: String(e.message || e).slice(0, 200) });
    stats.errors = stats.errors.slice(0, 20);
    await msg.reply("Oups, petit souci technique côté IA, réessaie dans un instant. 🙏");
    return;
  }
  const final = trunc(first ? FIRST_GREETING + "\n\n" + answer : answer);
  seen[uid] = true;
  await store.set("seen", seen);
  short.push({ role: "assistant", content: final.slice(0, 1000), ts: new Date().toISOString() });
  while (short.length > 20) short.shift();
  await store.set("short_" + uid, short);
  // 5) réponse dans le salon d'origine
  await msg.reply(final);
  stats.sent++;
  // 6) relais webhook optionnel (miroir vers un autre salon si configuré)
  if (CFG.webhook) {
    try {
      await fetch(CFG.webhook, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trunc("**" + uname + "** → " + final), username: CFG.botName.slice(0, 80), avatar_url: CFG.avatarUrl || undefined }) });
    } catch (_) { /* miroir best-effort, jamais bloquant */ }
  }
}

// Vrai si ce message est une RÉPONSE (reply Discord) à un message de Verity.
// Même sans mention ni préfixe, on considère que l'utilisateur s'adresse à elle.
async function isReplyToVerity(msg) {
  try {
    const refId = msg.reference && msg.reference.messageId;
    if (!refId) return false;
    const ref = await msg.channel.messages.fetch(refId);
    return !!(ref && ref.author && client.user && ref.author.id === client.user.id);
  } catch (_) { return false; } // message d'origine supprimé/inaccessible → pas de reply
}

// ---------- client Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.on("ready", () => console.log("[verity] connecté en tant que " + client.user.tag));
client.on("messageCreate", async (msg) => {
  try {
    if (CFG.ignoreBots && msg.author.bot) return;               // anti-boucle
    if (msg.author.id === client.user.id) return;               // jamais se répondre
    if (CFG.allowed.length && !CFG.allowed.includes(msg.channelId)) return;
    const mentioned = isMentioned(msg);
    const replyToMe = mentioned ? false : await isReplyToVerity(msg);
    const addressed = mentioned || replyToMe;
    if (!addressed && !CFG.autoMode) return;                   // ignore si pas sollicité
    if (addressed) stats.mentions++;
    await handleMessage(msg);
  } catch (e) {
    console.error("[verity] messageCreate :", e.message);
    stats.errors.unshift({ ts: new Date().toISOString(), err: String(e.message || e).slice(0, 200) });
  }
});

// ---------- mini API status (le dashboard Perchance peut la sonder) ----------
const app = express();
app.get("/status", (req, res) => res.json({ online: true, bot: client.user ? client.user.tag : "démarrage…", stats, time: new Date().toISOString() }));
app.get("/", (req, res) => res.send("Verity bot en ligne. GET /status pour l'état."));

(async () => {
  if (!CFG.token) { console.error("❌ DISCORD_TOKEN manquant. Copie env.example.txt vers .env et colle ton token."); process.exit(1); }
  if (!CFG.aiKey) console.warn("⚠️ AI_API_KEY manquante : le bot répondra par un message d'erreur IA tant qu'elle n'est pas définie.");
  await store.init();
  // purge rétention
  if (CFG.retentionDays > 0) {
    const cutoff = Date.now() - CFG.retentionDays * 864e5;
    const seen = await store.get("seen", {});
    for (const uid of Object.keys(seen)) {
      const arr = await store.get("long_" + uid, []);
      const kept = arr.filter(x => !x.ts || new Date(x.ts).getTime() > cutoff);
      if (kept.length !== arr.length) await store.set("long_" + uid, kept);
    }
  }
  app.listen(CFG.port, () => console.log("[verity] status HTTP sur :" + CFG.port + "/status"));
  await client.login(CFG.token);
})();
