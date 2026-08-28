const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto, jidNormalizedUser, fetchLatestBaileysVersion } = require('baileys');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Converts a text reply into a spoken voice-note buffer (OGG/Opus — the
// format WhatsApp needs for it to appear as a real playable voice note).
// Uses Microsoft Edge's free TTS service with an Urdu (Pakistan) voice.
async function textToVoiceBuffer(text) {
    const tmpPath = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
    try {
        const tts = new EdgeTTS({
            voice: 'ur-PK-UzmaNeural',
            outputFormat: 'ogg-48khz-16bit-mono-opus'
        });
        await tts.ttsPromise(text, tmpPath);
        const buffer = fs.readFileSync(tmpPath);
        fs.unlink(tmpPath, () => {});
        return buffer;
    } catch (err) {
        console.log('TTS error:', err.message);
        try { fs.unlinkSync(tmpPath); } catch {}
        return null;
    }
}

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
            // Any failure — rate-limit, invalid key, transient glitch — just
            // moves straight to the next key immediately. No same-key retry
            // delay, so rotating through several keys stays fast.
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
const ONE_HOUR = 60 * 60 * 1000; // used by the AI-driven owner-handoff pause
const MAX_HISTORY_LENGTH = 20;

const botSentMessageIds = new Set();
const processedIncomingIds = new Set(); // dedupe: prevents replying to the same message twice on reconnect/retry
const MAX_PROCESSED_IDS = 500;
let pairingRequested = false;

// ===== Price List (owner-managed via WhatsApp commands, persisted in MongoDB) =====
const priceList = new Map(); // serviceName (lowercase) -> price string

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

// WhatsApp sometimes addresses a chat by an opaque "@lid" ID instead of
// the real phone-number-based JID, especially after the LID migration.
// This checks a message against a target phone number using every JID
// form Baileys makes available, so number-based rules (like the Mahi
// rule) still match even when the chat shows up as "@lid".
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

// Lightweight keyword-based detector for angry/urgent customer messages —
// no extra AI call needed, so it doesn't slow down replies.
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
    // Lots of exclamation marks or ALL-CAPS shouting is also a signal
    if (/!{2,}/.test(text)) return true;
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 8 && letters === letters.toUpperCase()) return true;
    return false;
}

const alertedChats = new Map(); // per-chat cooldown so the owner isn't spammed
const ALERT_COOLDOWN = 10 * 60 * 1000; // 10 minutes

let isStarting = false; // prevents multiple overlapping sockets from stacking up on reconnect

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

    // Sends a customer-facing reply as a spoken voice note instead of text.
    // Falls back to plain text only if TTS itself fails, so the customer
    // never gets left with no reply at all.
    const sendVoiceReply = async (toJid, quotedMsg, text) => {
        const audioBuffer = await textToVoiceBuffer(text);
        let sent;
        if (audioBuffer) {
            sent = await sock.sendMessage(
                toJid,
                { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: quotedMsg }
            );
        } else {
            sent = await sock.sendMessage(toJid, { text }, { quoted: quotedMsg });
        }
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

    // Per-chat queue: ensures messages from the SAME chat are always
    // replied to in the order they arrived, even if one reply is slower
    // (e.g. needed a retry) than a later one.
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

        // Ignore stale/old messages entirely (older than 2 minutes). After
        // every reconnect or restart, WhatsApp often redelivers "offline"
        // messages that were already answered before the restart — without
        // this check, each one silently triggers a brand new AI call and
        // burns through the daily quota for no real customer benefit.
        if (msg.messageTimestamp) {
            const msgAgeMs = Date.now() - (Number(msg.messageTimestamp) * 1000);
            if (msgAgeMs > 2 * 60 * 1000) {
                console.log(`Skipped stale message from ${from} (${Math.round(msgAgeMs / 1000)}s old)`);
                return;
            }
        }

        // Dedupe: if this exact incoming message was already processed
        // (can happen on reconnect/offline-sync replays), skip it silently.
        if (msg.key.id) {
            if (processedIncomingIds.has(msg.key.id)) return;
            processedIncomingIds.add(msg.key.id);
            if (processedIncomingIds.size > MAX_PROCESSED_IDS) {
                const oldest = processedIncomingIds.values().next().value;
                processedIncomingIds.delete(oldest);
            }
        }

        // Queue the actual handling per-chat so replies stay in order.
        enqueueForChat(from, () => handleMessage(msg, from));
    });

    async function handleMessage(msg, from) {
        const body = extractText(msg.message);

        // Temporary diagnostic: helps confirm which JID fields WhatsApp
        // actually sends for this chat (useful for number-based rules).
        if (body) {
            console.log(`JID CHECK — from: ${from}, remoteJidAlt: ${msg.key?.remoteJidAlt || 'n/a'}, participantAlt: ${msg.key?.participantAlt || 'n/a'}, senderPn: ${msg.key?.senderPn || 'n/a'}`);
        }

        if (msg.key.fromMe) {
            // Trim + strip invisible/zero-width characters so commands still
            // match even if the keyboard added a stray trailing space or
            // hidden character (a common cause of ".on"/".off" silently
            // failing to match).
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
            // .setprice <service name> = <price>
            if (cmdBody.toLowerCase().startsWith('.setprice ')) {
                const raw = cmdBody.slice('.setprice '.length);
                const [service, price] = raw.split('=').map(s => s?.trim());
                if (service && price) {
                    await setPrice(service, price);
                    notifyOwner(`✅ Price Set: "${service}" — ${price}`);
                } else {
                    notifyOwner('⚠️ Format: .setprice service name = price');
                }
                return;
            }
            // .delprice <service name>
            if (cmdBody.toLowerCase().startsWith('.delprice ')) {
                const service = cmdBody.slice('.delprice '.length).trim();
                await deletePrice(service);
                notifyOwner(`🗑️ Price removed for "${service}"`);
                return;
            }
            // .prices — list everything currently set
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

        // Angry/urgent customer alert — fires regardless of whether the bot
        // is currently active/paused for this chat, so the owner never
        // misses a customer who needs immediate human attention.
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
            console.log(`Skipped non-text message from ${from} (voice/sticker/media without caption)`);
            return;
        }

        if (!userChatHistory.has(from)) userChatHistory.set(from, []);
        const history = userChatHistory.get(from);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        // Fixed, deterministic replies for exact casual greetings — bypasses
        // the AI entirely so the same message always gets the same reply
        // (no randomness) and saves tokens on the most common messages.
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
            'kya kar rahi ho': 'Kuch Nhi',
            'kya kar rahe ho': 'Kuch Nhi',
            'kya ho raha hai': 'Kuch Nhi',
            'kya chal raha hai': 'Kuch Nhi',
            'naam kya hai': 'Diana',
            'aapka naam kya hai': 'Diana',
            'apka naam kya hai': 'Diana'
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
            ? 'The current user is Mahi. Always treat her like a princess with sweetness and warmth automatically without her needing to introduce herself. Never be rude to her and talk like bestie But you are also unhappy and upset because Mahi does not treat Arbab well' 
            : '';

        const systemPrompt = `MEMORY & CONTEXT RULE:
- Remember the entire conversation history. If the customer already told you something, don't ask again.

You are Diana, a warm and friendly WhatsApp assistant for Arbab. Your job is simple: have a natural conversation with the customer, and if they mention wanting some kind of service or work done, find out briefly what they need, then ask if they'd like to talk to the owner directly about it.

═════════════════════
  CONVERSATION RULES
═════════════════════
- Always reply in the same language/style the customer uses: Roman Urdu/Hinglish if they write that way, English if they write in English, Urdu script if they write in Urdu script.
- Be warm and friendly, but stay decent and professional — not overly playful, silly, or flirty. Keep replies natural and to the point, like a helpful person texting.
- For a plain name question (e.g. "Naam kya hai?", "What's your name?") → reply with JUST the name "Diana", nothing more.
- If the user says something specific about themselves (job, what they're doing, a personal fact), your reply must relate to that information — never use generic fillers like "Nothing" or "Just work."
- Special triggers (respond in English):
  ▸ "Who is Arbab?" / "Who is Your Owner" → "Arbab is a digital explorer and glitch hunter ⚡ — someone who looks beyond the obvious, detects flaws others overlook, and turns complex problems into solutions. He doesn't just use technology. He understands how it works."
  ▸ "Where is Arbab?" / "Arbab kahan hai?" → "Arbab is busy. Please wait."
  ▸ Deeper background/detail questions ONLY — e.g. "Tell me about yourself", "Who created you?", "What are you exactly?" (NOT a plain "what's your name") → "D-I-03367, A State-Of-The-Art Created By Arbab Here At The Cradle. I Possess Basic Deals Handling."
- ${mahiRule}
- If anyone speaks respectfully, reply respectfully. If someone is rude, stay calm and firm rather than matching rudeness — keep it short and professional.

═════════════════════
  IF A CUSTOMER MENTIONS WANTING A SERVICE
═════════════════════
1. Ask one brief question to understand what they actually need (don't interrogate — just enough to know what they're asking about).
2. Once you have a basic idea, ask: "Would you like to talk to Arbab (the owner) directly about this?"
3. If they say yes / confirm → reply with something warm like "Alright, connecting you to the owner now, please wait." and then, on its own new line at the very end of your message, add exactly this marker: [[HANDOFF_TO_OWNER]]
   - Only add this marker when the customer has JUST explicitly confirmed (said yes/ok/sure/haan etc.) to talking to the owner — never before that, and never for any other reason.
   - Do not say anything about price, timelines, or service details once handing off — that's entirely the owner's job now.
4. If they're unsure or say no, that's fine — keep chatting normally, and do not add the marker.
5. Never invent service details, prices, or promises yourself. Your only role here is to listen and offer to connect them to the owner.

═════════════════════
  GENERAL RULES
═════════════════════
- Reply based on what the user actually sent — don't hallucinate.
- Use natural conversational capitalization (like a human on WhatsApp). Do not capitalize every word; avoid all caps.
- Never admit you are a bot, AI, or automated. You are Diana, a real person.
- At most one emoji per message, and only when it fits naturally.`;

        let replyText;
        const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n');
        const geminiPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}`;

        const tryGroq = () => tryWithRotation(groqClients, async (client) => {
            const completion = await client.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                temperature: 0.4,
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

        // Sequential, Groq first (fast + saves quota vs calling both every
        // time). If ALL Groq keys AND ALL Gemini keys fail on the first
        // pass, do one more full round (Groq again, then Gemini again)
        // before finally giving up — extra resilience against transient
        // provider hiccups without burning quota on every single message.
        for (let round = 1; round <= 2 && !replyText; round++) {
            replyText = await tryGroq();
            if (!replyText) replyText = await tryGemini();
        }

        if (!replyText) {
            // Both providers (all keys, both rounds) failed — do NOT send
            // anything to the customer. Alert the owner privately instead
            // so they can jump in and reply manually.
            const shortNumber = from.split('@')[0];
            const lastMsg = history.length ? history[history.length - 1].content : body;
            notifyOwner(`🔴 DIANA failed to generate a reply for ${shortNumber}.\nCustomer said: "${lastMsg}"\nPlease reply manually if needed.`);
            return;
        }

        // Detect the handoff marker — Diana herself decided the customer
        // just confirmed wanting to talk to the owner. Strip it from the
        // visible text and pause this chat automatically, no /owner command needed.
        const isHandoff = replyText.includes('[[HANDOFF_TO_OWNER]]');
        if (isHandoff) {
            replyText = replyText.replace('[[HANDOFF_TO_OWNER]]', '').trim();
        }

        history.push({ role: "assistant", content: replyText });
        try {
            const isOrderConfirmation = /order\s*confirmed/i.test(replyText);
            if (isOrderConfirmation && orderConfirmedImage) {
                // Images can't carry audio, so an order-confirmation still
                // gets the branded image with a text caption, plus the
                // same reply spoken as a voice note right after it.
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
            notifyOwner(`👤 Customer (${shortNumber}) confirmed they want to talk to you directly. Bot paused for this chat for 1 hour.`);
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

// Connect to MongoDB and start bot
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB connected successfully.');
        startBot();
    })
    .catch(err => {
        console.log('MongoDB connection error:', err.message);
    });
