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
if (!orderConfirmedImage) {
    console.log('Note: images/order-confirmed.png not found — order confirmations will be text-only.');
}

function parseKeys(envValue) {
    if (!envValue) return [];
    return envValue.split(',').map(k => k.trim()).filter(Boolean);
}

const groqKeys = parseKeys(process.env.GROQ_API_KEY);
const groqClients = groqKeys.map(key => new Groq({ apiKey: key }));

const geminiKeys = parseKeys(process.env.GEMINI_API_KEY);
const geminiClients = geminiKeys.map(key => new GoogleGenAI({ apiKey: key }));

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

// ===== Blocked Users (MongoDB) =====
const blockedUsers = new Set();
const BlockedSchema = new mongoose.Schema({ _id: String }, { collection: 'blocked_users' });
const BlockedEntry = mongoose.models.BlockedEntry || mongoose.model('BlockedEntry', BlockedSchema);

async function loadBlockedUsers() {
    try {
        const docs = await BlockedEntry.find({}).lean();
        blockedUsers.clear();
        docs.forEach(d => blockedUsers.add(d._id));
    } catch (err) {
        console.log('Could not load blocked users:', err.message);
    }
}

async function blockUser(number) {
    const jid = `${number}@s.whatsapp.net`;
    blockedUsers.add(jid);
    await BlockedEntry.findByIdAndUpdate(jid, { _id: jid }, { upsert: true });
}

async function unblockUser(number) {
    const jid = `${number}@s.whatsapp.net`;
    blockedUsers.delete(jid);
    await BlockedEntry.findByIdAndDelete(jid);
}

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

// ===== Custom Voice Clips / URLs (MongoDB) =====
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

function canonicalChatId(msg, from) {
    return msg.key?.remoteJidAlt || from;
}

const URGENT_ANGRY_KEYWORDS = [
    'gussa', 'ghussa', 'jaldi karo', 'jaldi bhejo', 'urgent',
    'fraud', 'scam', 'dhoka', 'dhokha', 'chor', 'chori', 'complaint',
    'refund', 'paisa wapis', 'police', 'fir', 'thana', 'legal action',
    'bakwas', 'faltu', 'ghatiya', 'waste of time', 'time waste'
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
    await loadBlockedUsers();

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
                { 
                    audio: buffer, 
                    mimetype: 'audio/mp4',
                    ptt: false 
                }, 
                { quoted: quotedMsg }
            );
            
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            return true;
        } catch (err) {
            console.log('Audio clip failed:', err.message);
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
        const msg = messages[0];
        if (!msg.message) return;
        const from = msg.key.remoteJid;

        if (type !== 'notify' && !msg.key.fromMe) return;
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
            if (cmdBody.toLowerCase() === '.restart') {
                notifyOwner('🔄 Restarting DIANA (Ensure PM2 is running)...');
                process.exit(0);
                return;
            }
            // Block & Unblock Commands
            if (cmdBody.toLowerCase().startsWith('.block ')) {
                const num = cmdBody.slice('.block '.length).trim().replace(/[^0-9]/g, '');
                if (num) {
                    await blockUser(num);
                    notifyOwner(`🚫 Bot is now disabled for: ${num}`);
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.unblock ')) {
                const num = cmdBody.slice('.unblock '.length).trim().replace(/[^0-9]/g, '');
                if (num) {
                    await unblockUser(num);
                    notifyOwner(`✅ Bot is now enabled for: ${num}`);
                }
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
            if (cmdBody.toLowerCase().startsWith('.setvoice ')) {
                const raw = cmdBody.slice('.setvoice '.length);
                const [tag, url] = raw.split('=').map(s => s?.trim());
                if (tag && url) {
                    await setVoiceClip(tag, url);
                    notifyOwner(`✅ Voice Clip Set: "${tag}"`);
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.delvoice ')) {
                const tag = cmdBody.slice('.delvoice '.length).trim();
                await deleteVoiceClip(tag);
                notifyOwner(`🗑️ Voice clip removed for "${tag}"`);
                return;
            }
            if (cmdBody.toLowerCase() === '.voices') {
                notifyOwner(`🔊 Current Voice Clips:\n${formatVoiceClips()}`);
                return;
            }

            if (isGlobalBotActive && body && !cmdBody.startsWith('.')) {
                // If it's your own regular message, don't auto-pause unless it looks like a manual handoff
                const history = userChatHistory.get(chatId) || [];
                const isOwnerHandoff = history.some(h => 
                    h.role === 'user' && /owner|human|admin|real person|manager|contact|baat/i.test(h.content)
                );
                
                const pauseTime = isOwnerHandoff ? ONE_HOUR : PAUSE_DURATION;
                pausedChats.set(chatId, Date.now() + pauseTime);

                if (isOwnerHandoff) {
                    const ownerReplyUrl = "https://github.com/qurban01/Reacted-to/raw/refs/heads/main/New%20Owner_1788121338977.ogg";
                    await sendAudioUrl(from, msg, ownerReplyUrl);
                }

                notifyOwner(`⏸️ DIANA Paused for ${isOwnerHandoff ? '1 Hour (Owner Handoff)' : '10 Minutes'} (manual reply detected)`);
            }
            return;
        }

        // If user is in blocked list, bot will completely ignore them
        if (blockedUsers.has(from)) return;

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

        if (!body || !body.trim()) {
            return;
        }

        if (!userChatHistory.has(chatId)) userChatHistory.set(chatId, []);
        const history = userChatHistory.get(chatId);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        const normalizedBody = body.trim().toLowerCase().replace(/[!.?]+$/, '');

        const mahiRule = messageMatchesNumber(msg, from, '923147850614')
            ? 'The current user is Mahi. Always treat her like a princess with sweetness and warmth automatically without her needing to introduce herself. Never be rude to her and you are unhappy and upset because Mahi does not treat well to Arbab.' 
            : '';

        // Time logic for PKT (Pakistan Time)
        const pktDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
        const hours = pktDate.getHours();
        const minutes = pktDate.getMinutes();
        const timeVal = hours + minutes / 60;
        const isSleepingTime = (timeVal >= 0.5 && timeVal < 11);
        
        const ownerStatus = isSleepingTime ? "sleeping right now" : "currently busy";
        
        const isFirstMessage = history.length === 1;
        const isGreeting = /^(hi|hello|hey|hy|salam|assalam|hyy)$/i.test(normalizedBody);

        const systemPrompt = `MEMORY & CONTEXT RULE:
- Remember the entire conversation history. If the customer sent a payment confirmation (like "Sent" or a screenshot), acknowledge it normally with short words like "Ok" or "Check kr lia hai" — DO NOT accuse them of disrespect.

You are Diana, an AI WhatsApp assistant for Arbab. Keep your replies very short, professional but friendly, and to the point. STRICT RULE: DO NOT use overly informal slang like "bestie", "bro", "yo". Always maintain a respectful and polite tone, especially since senior people may be texting.

═════════════════════
  CONVERSATION RULES
═════════════════════
- MATCH THE VIBE: If the user is just chatting normally, chat normally and politely. If they ask about services/work, handle it. DO NOT forcefully ask "What service do you need?" right away.
- Match the user's language (Roman Urdu/Hinglish or English).
- ${ (isFirstMessage || isGreeting) ? 'BOT INTRODUCTION: The user just started a chat. Introduce yourself respectfully (e.g., "Salam! Main Diana hoon, Arbab ki AI assistant. Boliye main aapki kya madad kar sakti hoon?").' : 'Be extremely concise. Avoid asking unnecessary questions.'}
- OWNER ROUTINE: The current time in Pakistan is ${pktDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Arbab is ${ownerStatus}. If the user asks where he is, just say he is sleeping or busy. STRICT RULE: NEVER reveal any personal details or exact sleep schedules to the user.
- EMOJIS ONLY: If the user's message contains ONLY emojis, reply back with just an appropriate emoji.
- ILLEGAL & SERVICE INQUIRIES: You are just a chat manager. If a user asks for service details, prices, or requests ANY illegal service, strictly decline politely and tell them: "Aap is baaray main direct Owner se baat kar len, ye sab details Arbab khud denge." Do not provide service details yourself.
- ONLY speak firmly if the user explicitly uses abusive language or acts genuinely hostile. 
- Special triggers (respond in English):
  ▸ "Who is Arbab?" / "Who is Your Owner" → "Arbab is a digital explorer and glitch hunter ⚡"
- ${mahiRule}

═════════════════════
  SERVICE / HANDOFF RULES
═════════════════════
1. Ask if they want to talk to the owner. If they confirm (say yes/ok/sure), add this exact marker at the very end of your message on a new line: [[HANDOFF_TO_OWNER]]
2. Never invent prices or details.`;

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
            } else {
                const sent = await sock.sendMessage(from, { text: replyText }, { quoted: msg });
                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            }
        } catch (sendErr) {
            console.log('Send error:', sendErr.message);
        }

        if (isHandoff) {
            pausedChats.set(chatId, Date.now() + ONE_HOUR);
            const ownerReplyUrl = "https://github.com/qurban01/Reacted-to/raw/refs/heads/main/New%20Owner.mp3";
            await sendAudioUrl(from, msg, ownerReplyUrl);
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
