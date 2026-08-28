const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto, jidNormalizedUser, fetchLatestBaileysVersion } = require('baileys');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// "Order Confirmed" branded image — sent alongside the reply whenever an
// order gets confirmed, for a more professional/branded feel.
const orderConfirmedImagePath = path.join(__dirname, 'images', 'order-confirmed.png');
const orderConfirmedImage = fs.existsSync(orderConfirmedImagePath)
    ? fs.readFileSync(orderConfirmedImagePath)
    : null;
if (!orderConfirmedImage) {
    console.log('Note: images/order-confirmed.png not found — order confirmations will be text-only.');
}

// Support multiple comma-separated API keys per provider (e.g. from several
// free accounts) — the bot rotates to the next key automatically when one
// hits its rate limit, multiplying total daily capacity.
function parseKeys(envValue) {
    if (!envValue) return [];
    return envValue.split(',').map(k => k.trim()).filter(Boolean);
}

const groqKeys = parseKeys(process.env.GROQ_API_KEY);
const groqClients = groqKeys.map(key => new Groq({ apiKey: key }));

const geminiKeys = parseKeys(process.env.GEMINI_API_KEY);
const geminiClients = geminiKeys.map(key => new GoogleGenAI({ apiKey: key }));

// Temporary diagnostic: shows how many keys were parsed and a safe
// preview of each (first 10 chars + total length) — no full key exposed.
console.log(`ENV CHECK — parsed ${groqKeys.length} Groq key(s), ${geminiKeys.length} Gemini key(s):`);
groqKeys.forEach((k, i) => {
    console.log(`  Groq Key #${i + 1}: starts with "${k.slice(0, 10)}", length ${k.length}`);
});
geminiKeys.forEach((k, i) => {
    console.log(`  Gemini Key #${i + 1}: starts with "${k.slice(0, 10)}", length ${k.length}`);
});

// Tries each client in order, returns the first successful result.
async function tryWithRotation(clients, fn, label) {
    for (let i = 0; i < clients.length; i++) {
        try {
            return await fn(clients[i]);
        } catch (err) {
            console.log(`${label} key #${i + 1} failed:`, err.message);
        }
    }
    return null;
}

// Bot State & Memory
let isGlobalBotActive = true;
const pausedChats = new Map();
const userChatHistory = new Map();
const PAUSE_DURATION = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const MAX_HISTORY_LENGTH = 20;

const botSentMessageIds = new Set();
const processedIncomingIds = new Set();
const MAX_PROCESSED_IDS = 500;
let pairingRequested = false;

// ===== Price List =====
const priceList = new Map();
const PriceSchema = new mongoose.Schema({ _id: String, price: String }, { collection: 'price_list' });
const PriceEntry = mongoose.models.PriceEntry || mongoose.model('PriceEntry', PriceSchema);

async function loadPriceList() {
    try {
        const docs = await PriceEntry.find({}).lean();
        priceList.clear();
        docs.forEach(d => priceList.set(d._id, d.price));
        console.log(`Loaded ${priceList.size} price entries from MongoDB.`);
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

function messageMatchesNumber(msg, from, phoneNumber) {
    const targetPn = `${phoneNumber}@s.whatsapp.net`;
    const candidates = [
        from,
        msg.key?.remoteJidAlt,
        msg.key?.participantAlt,
        msg.key?.senderPn
    ].filter(Boolean);
    return candidates.some(jid => jid === targetPn || jid.startsWith(`${phoneNumber}:`) || jid.startsWith(`${phoneNumber}@`));
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

    const sendVoiceReply = async (toJid, quotedMsg, text) => {
        const sent = await sock.sendMessage(toJid, { text }, { quoted: quotedMsg });
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        return sent;
    };

    if (!state.creds.registered && process.env.PHONE_NUMBER && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(process.env.PHONE_NUMBER);
                console.log('\n==========================================');
                console.log(`YOUR WA PAIRING CODE IS: ${code}`);
                console.log('==========================================\n');
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
            if (cmdBody.toLowerCase().startsWith('.delprice ')) {
                const service = cmdBody.slice('.delprice '.length).trim();
                await deletePrice(service);
                notifyOwner(`🗑️ Price removed for "${service}"`);
                return;
            }
            if (cmdBody.toLowerCase() === '.prices') {
                notifyOwner(`📋 Current Prices:\n${formatPriceList()}`);
                return;
            }
            if (isGlobalBotActive && body && !cmdBody.startsWith('.')) {
                pausedChats.set(from, Date.now() + PAUSE_DURATION);
                notifyOwner('⏸️ DIANA Paused (manual reply detected)');
            }
            return;
        }

        if (body && isUrgentOrAngry(body)) {
            const lastAlert = alertedChats.get(from) || 0;
            if (Date.now() - lastAlert > ALERT_COOLDOWN) {
                alertedChats.set(from, Date.now());
                const shortNumber = from.split('@')[0];
                notifyOwner(`⚠️ Possible angry/urgent customer (${shortNumber}):\n"${body}"`);
            }
        }

        if (!isGlobalBotActive || (pausedChats.has(from) && Date.now() < pausedChats.get(from))) return;

        if (!body || !body.trim()) {
            console.log(`Skipped non-text message from ${from}`);
            return;
        }

        if (!userChatHistory.has(from)) userChatHistory.set(from, []);
        const history = userChatHistory.get(from);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        const CANNED_REPLIES = {
            'hi': 'Hn G',
            'hello': 'Hn G',
            'hey': 'Hn G',
            'kese ho': 'Theek, Tum Batao',
            'kaise ho': 'Theek, Tum Batao',
            'kaisa ho': 'Theek, Tum Batao',
            'kisa ho': 'Theek, Tum Batao',
            'kesa ho': 'Theek, Tum Batao',
            'kese ho ap': 'Theek, Tum Batao',
            'kya haal hai': 'Theek, Tum Batao',
            'haal chaal': 'Theek, Tum Batao',
            'sent': 'Ok',
            'ok': 'Hmm',
            'haan': 'Hn G',
            'hain': 'Hn G'
        };
        const normalizedBody = body.trim().toLowerCase().replace(/[!.?]+$/, '');

        if (CANNED_REPLIES[normalizedBody]) {
            const cannedText = CANNED_REPLIES[normalizedBody];
            history.push({ role: "assistant", content: cannedText });
            try {
                await sendVoiceReply(from, msg, cannedText);
            } catch (sendErr) { console.log('Send error:', sendErr.message); }
            return;
        }

        const mahiRule = messageMatchesNumber(msg, from, '923147850614')
            ? 'The current user is Mahi. Always treat her like a princess with sweetness and warmth automatically without her needing to introduce herself. Never be rude to her and you are unhappy and upset because Mahi does not treat well to Arbab.' 
            : '';

        const systemPrompt = `MEMORY & CONTEXT RULE:
- Remember the entire conversation history. If the customer sent a payment confirmation (like "Sent" or a screenshot), acknowledge it normally with short words like "Ok" or "Check kr lia hai" — DO NOT accuse them of disrespect or end the conversation.

You are Diana, a concise and direct WhatsApp assistant for Arbab. Keep your replies very short, professional, and to the point. Do not ask unnecessary questions or do useless small talk.

═════════════════════
  CONVERSATION RULES
═════════════════════
- Match the user's language (Roman Urdu/Hinglish or English).
- Be extremely concise. Avoid asking unnecessary or repetitive questions. 
- ONLY speak rudely if the user explicitly uses abusive language, insults you, or acts genuinely hostile. Never treat normal updates like "Sent", "Ok", or short replies as rude.
- For a plain name question -> reply with JUST the name "Diana".
- Special triggers (respond in English):
  ▸ "Who is Arbab?" / "Who is Your Owner" → "Arbab is a digital explorer and glitch hunter ⚡"
  ▸ "Where is Arbab?" → "Arbab is busy."
- ${mahiRule}

═════════════════════
  SERVICE / HANDOFF RULES
═════════════════════
1. If they want a service, be direct. 
2. Ask if they want to talk to the owner. If they confirm (say yes/ok/sure), add this exact marker at the very end of your message on a new line: [[HANDOFF_TO_OWNER]]
3. Never invent prices or details.`;

        let replyText;
        const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n');
        const geminiPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}`;

        const tryGroq = () => tryWithRotation(groqClients, async (client) => {
            const completion = await client.chat.completions.create({
                model: "openai/gpt-oss-120b",
                temperature: 0.3,
                messages: [{ role: "system", content: systemPrompt }, ...history]
            });
            return completion.choices[0].message.content;
        }, 'Groq');

        const tryGemini = () => tryWithRotation(geminiClients, async (client) => {
            const result = await client.models.generateContent({
                model: "gemini-3.7-flash",
                contents: geminiPrompt
            });
            return result.text;
        }, 'Gemini');

        for (let round = 1; round <= 1 && !replyText; round++) {
            replyText = await tryGroq();
            if (!replyText) replyText = await tryGemini();
        }

        if (!replyText) {
            const shortNumber = from.split('@')[0];
            const lastMsg = history.length ? history[history.length - 1].content : body;
            notifyOwner(`🔴 DIANA failed to generate a reply for ${shortNumber}.\nCustomer said: "${lastMsg}"`);
            return;
        }

        const isHandoff = replyText.includes('[[HANDOFF_TO_OWNER]]');
        if (isHandoff) {
            replyText = replyText.replace('[[HANDOFF_TO_OWNER]]', '').trim();
        }

        history.push({ role: "assistant", content: replyText });
        try {
            const isOrderConfirmation = /order\s*confirmed/i.test(replyText);
            if (isOrderConfirmation && orderConfirmedImage) {
                const sent = await sock.sendMessage(
                    from,
                    { image: orderConfirmedImage, caption: replyText },
                    { quoted: msg }
                );
                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                await sendVoiceReply(from, msg, replyText);
            } else {
                await sendVoiceReply(from, msg, replyText);
            }
        } catch (sendErr) {
            console.log('Send error:', sendErr.message);
        }

        if (isHandoff) {
            pausedChats.set(from, Date.now() + ONE_HOUR);
            const shortNumber = from.split('@')[0];
            notifyOwner(`👤 Customer (${shortNumber}) confirmed they want to talk to you directly. Bot paused for 1 hour.`);
        }
    }

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            isStarting = false;
            console.log('DIANA Active');
            notifyOwner('✅ DIANA Connected');
        } else if (u.connection === 'close') {
            isStarting = false;
            const statusCode = u.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB connected successfully.');
        startBot();
    })
    .catch(err => {
        console.log('MongoDB connection error:', err.message);
    });
