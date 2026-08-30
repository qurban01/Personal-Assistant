const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto, jidNormalizedUser, fetchLatestBaileysVersion } = require('baileys');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const orderConfirmedImagePath = path.join(__dirname, 'images', 'order-confirmed.png');
const orderConfirmedImage = fs.existsSync(orderConfirmedImagePath)
    ? fs.readFileSync(orderConfirmedImagePath)
    : null;

function parseKeys(envValue) {
    if (!envValue) return [];
    return envValue.split(',').map(k => k.trim()).filter(Boolean);
}

const groqKeys = parseKeys(process.env.GROQ_API_KEY);
const groqClients = groqKeys.map(key => new Groq({ apiKey: key }));

const geminiKeys = parseKeys(process.env.GEMINI_API_KEY);
const geminiClients = geminiKeys.map(key => new GoogleGenAI({ apiKey: key }));

// Bot State & Memory
let isGlobalBotActive = true;
const pausedChats = new Map();
const userChatHistory = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; // 5 minutes default
const ONE_HOUR = 60 * 60 * 1000;      // 1 hour for owner handoff
const MAX_HISTORY_LENGTH = 20;

const botSentMessageIds = new Set();
const processedIncomingIds = new Set();
const MAX_PROCESSED_IDS = 500;
let pairingRequested = false;

// ===== Price List (MongoDB) =====
const priceList = new Map();
const PriceSchema = new mongoose.Schema({ _id: String, price: String }, { collection: 'price_list' });
const PriceEntry = mongoose.models.PriceEntry || mongoose.model('PriceEntry', PriceSchema);

async function loadPriceList() {
    try {
        const docs = await PriceEntry.find({}).lean();
        priceList.clear();
        docs.forEach(d => priceList.set(d._id, d.price));
    } catch (err) {
        console.log('Could not load price list:', err.message);
    }
}

async function setPrice(service, price) {
    const key = service.trim().toLowerCase();
    priceList.set(key, price.trim());
    await PriceEntry.findByIdAndUpdate(key, { price: price.trim() }, { upsert: true });
}

async function deletePrice(service) {
    const key = service.trim().toLowerCase();
    priceList.delete(key);
    await PriceEntry.findByIdAndDelete(key);
}

function formatPriceList() {
    if (priceList.size === 0) return 'No prices set yet.';
    return [...priceList.entries()].map(([k, v]) => `• ${k} — ${v}`).join('\n');
}

// ===== Custom Voice Clips (GitHub Raw URLs) =====
const voiceClips = new Map();
const VoiceSchema = new mongoose.Schema({ _id: String, url: String }, { collection: 'voice_clips' });
const VoiceEntry = mongoose.models.VoiceEntry || mongoose.model('VoiceEntry', VoiceSchema);

async function loadVoiceClips() {
    try {
        const docs = await VoiceEntry.find({}).lean();
        voiceClips.clear();
        docs.forEach(d => voiceClips.set(d._id, d.url));
    } catch (err) {
        console.log('Could not load voice clips:', err.message);
    }
}

async function setVoiceClip(tag, url) {
    const key = tag.trim().toLowerCase();
    voiceClips.set(key, url.trim());
    await VoiceEntry.findByIdAndUpdate(key, { url: url.trim() }, { upsert: true });
}

async function deleteVoiceClip(tag) {
    const key = tag.trim().toLowerCase();
    voiceClips.delete(key);
    await VoiceEntry.findByIdAndDelete(key);
}

function formatVoiceClips() {
    if (voiceClips.size === 0) return 'No voice clips set yet.';
    return [...voiceClips.entries()].map(([k, v]) => `• ${k} — ${v}`).join('\n');
}

// ===== MongoDB Auth =====
async function useMongoAuthState(sessionId) {
    const AuthKeySchema = new mongoose.Schema({ _id: String, value: String }, { collection: 'baileys_auth' });
    const AuthKey = mongoose.models.AuthKey || mongoose.model('AuthKey', AuthKeySchema);

    const readData = async (key) => {
        const doc = await AuthKey.findById(`${sessionId}:${key}`).lean();
        return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null;
    };
    const writeData = async (key, data) => {
        await AuthKey.findByIdAndUpdate(`${sessionId}:${key}`, { value: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
    };
    const removeData = async (key) => { await AuthKey.findByIdAndDelete(`${sessionId}:${key}`); };
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let v = await readData(`${type}-${id}`); if(type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v); data[id] = v; })); return data; }, set: async (data) => { const tasks = []; for (const c in data) for (const id in data[c]) { const v = data[c][id]; tasks.push(v ? writeData(`${c}-${id}`, v) : removeData(`${c}-${id}`)); } await Promise.all(tasks); } } },
        saveCreds: async () => await writeData('creds', creds)
    };
}

function extractText(message) {
    if (!message) return null;
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    return null;
}

function canonicalChatId(msg, from) {
    return msg.key?.remoteJidAlt || from;
}

const URGENT_ANGRY_KEYWORDS = [
    'gussa', 'gussy', 'ghussa', 'jaldi karo', 'jaldi bhejo', 'urgent',
    'fraud', 'scam', 'dhoka', 'dhokha', 'chor', 'chori', 'complaint',
    'refund', 'paisa wapis', 'police', 'fir', 'thana', 'legal action',
    'bakwas', 'faltu', 'ghatiya', 'waste of time', 'time waste',
    'kaha ho', 'kaha reh gaye', 'kab tak', 'bohat late', 'bahut late'
];

function isUrgentOrAngry(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (URGENT_ANGRY_KEYWORDS.some(k => lower.includes(k))) return true;
    if (/!{2,}/.test(text)) return true;
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 8 && letters === letters.toUpperCase()) return true;
    return false;
}

const alertedChats = new Map();
const ALERT_COOLDOWN = 10 * 60 * 1000;
let isStarting = false;

async function startBot() {
    if (isStarting) return;
    isStarting = true;
    await loadPriceList();
    await loadVoiceClips();
    
    const { state, saveCreds } = await useMongoAuthState('daina-session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });

    sock.ev.on('creds.update', saveCreds);

    const notifyOwner = async (text) => {
        try {
            const rawId = sock.user?.id;
            if (!rawId) return;
            const ownJid = jidNormalizedUser(rawId);
            const sent = await sock.sendMessage(ownJid, { text });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        } catch (err) {
            console.log('Could not send owner notification:', err.message);
        }
    };

    const sendAudioUrl = async (toJid, quotedMsg, url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            const sent = await sock.sendMessage(
                toJid,
                { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: quotedMsg }
            );
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            return true;
        } catch (err) {
            console.log(`Audio clip failed:`, err.message);
            return false;
        }
    };

    const sendCustomVoiceClip = async (toJid, quotedMsg, tag) => {
        const url = voiceClips.get(tag.trim().toLowerCase());
        if (!url) return false;
        return await sendAudioUrl(toJid, quotedMsg, url);
    };

    if (!state.creds.registered && process.env.PHONE_NUMBER && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(process.env.PHONE_NUMBER);
                console.log(`\nYOUR WA PAIRING CODE IS: ${code}\n`);
            } catch (err) {
                console.log('Error getting pairing code:', err.message);
            }
        }, 3000);
    }

    const chatQueues = new Map();
    function enqueueForChat(chatId, task) {
        const prev = chatQueues.get(chatId) || Promise.resolve();
        const next = prev.then(task).catch(err => console.log('Queue task error:', err.message));
        chatQueues.set(chatId, next);
        return next;
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;
        const from = msg.key.remoteJid;

        if (!from || from === 'status@broadcast' || from.endsWith('@g.us') || from.endsWith('@newsletter')) return;

        if (botSentMessageIds.has(msg.key.id)) {
            botSentMessageIds.delete(msg.key.id);
            return;
        }

        if (msg.messageTimestamp) {
            const msgAgeMs = Date.now() - (Number(msg.messageTimestamp) * 1000);
            if (msgAgeMs > 2 * 60 * 1000) return;
        }

        if (msg.key.id) {
            if (processedIncomingIds.has(msg.key.id)) return;
            processedIncomingIds.add(msg.key.id);
            if (processedIncomingIds.size > MAX_PROCESSED_IDS) {
                const oldest = processedIncomingIds.values().next().value;
                processedIncomingIds.delete(oldest);
            }
        }

        enqueueForChat(from, () => handleMessage(msg, from));
    });

    async function handleMessage(msg, from) {
        const body = extractText(msg.message);
        const chatId = canonicalChatId(msg, from);

        if (msg.key.fromMe) {
            const cmdBody = (body || '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
            
            if (cmdBody.toLowerCase() === '.on') {
                isGlobalBotActive = true;
                pausedChats.clear();
                userChatHistory.clear();
                notifyOwner('🕸️ DIANA Connected 🕸️');
                return;
            }
            if (cmdBody.toLowerCase() === '.off') {
                isGlobalBotActive = false;
                notifyOwner('⏸️ DIANA Paused');
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.setprice ')) {
                const raw = cmdBody.slice('.setprice '.length);
                const [service, price] = raw.split('=').map(s => s?.trim());
                if (service && price) {
                    await setPrice(service, price);
                    notifyOwner(`✅ Price Set: "${service}" — ${price}`);
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.setvoice ')) {
                const raw = cmdBody.slice('.setvoice '.length);
                const [tag, url] = raw.split('=').map(s => s?.trim());
                if (tag && url) {
                    await setVoiceClip(tag, url);
                    notifyOwner(`✅ Voice Clip Set: "${tag}"`);
                }
                return;
            }

            if (isGlobalBotActive && body && !cmdBody.startsWith('.')) {
                const history = userChatHistory.get(chatId) || [];
                const isOwnerHandoff = history.some(h => 
                    h.role === 'user' && /owner|human|admin|real person|manager|contact|baat/i.test(h.content)
                );
                
                const pauseTime = isOwnerHandoff ? ONE_HOUR : PAUSE_DURATION;
                pausedChats.set(chatId, Date.now() + pauseTime);

                // Agar owner handoff trigger hua hai, to specific GitHub raw audio link send karein as a reply
                if (isOwnerHandoff) {
                    const ownerReplyUrl = "https://github.com/qurban01/Reacted-to/raw/refs/heads/main/Owner%20Reply.mp3";
                    await sendAudioUrl(from, msg, ownerReplyUrl);
                }

                notifyOwner(`⏸️ DIANA Paused for ${isOwnerHandoff ? '1 Hour (Owner Handoff)' : '5 Minutes'}`);
            }
            return;
        }

        // Custom keyword / emotion based responses (e.g. greeting or text match)
        if (body) {
            const lowerBody = body.toLowerCase().trim();
            if (voiceClips.has(lowerBody)) {
                await sendCustomVoiceClip(from, msg, lowerBody);
                return;
            }
        }

        if (body && isUrgentOrAngry(body)) {
            const lastAlert = alertedChats.get(chatId) || 0;
            if (Date.now() - lastAlert > ALERT_COOLDOWN) {
                alertedChats.set(chatId, Date.now());
                const shortNumber = from.split('@')[0];
                notifyOwner(`⚠️ Possible angry/urgent customer (${shortNumber}):\n"${body}"`);
                await sendCustomVoiceClip(from, msg, 'rude');
            }
        }

        if (!isGlobalBotActive || (pausedChats.has(chatId) && Date.now() < pausedChats.get(chatId))) return;
        if (!body || !body.trim()) return;

        if (!userChatHistory.has(chatId)) userChatHistory.set(chatId, []);
        const history = userChatHistory.get(chatId);
        history.push({ role: 'user', content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();
    }
}

startBot();
