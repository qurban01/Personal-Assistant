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
const spamTracker = new Map(); 
const PAUSE_DURATION = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const MAX_HISTORY_LENGTH = 20;

const botSentMessageIds = new Set();
const processedIncomingIds = new Set();
const MAX_PROCESSED_IDS = 500;
let pairingRequested = false;

// ===== Anti-Spam Settings =====
const SPAM_LIMIT = 5; 
const SPAM_WINDOW = 10000; 

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

// ===== Bot Custom Prompt (MongoDB) =====
let customSystemPrompt = "";
const PromptSchema = new mongoose.Schema({ _id: String, prompt: String }, { collection: 'bot_prompt' });
const PromptEntry = mongoose.models.PromptEntry || mongoose.model('PromptEntry', PromptSchema);

async function loadCustomPrompt() {
    try {
        const doc = await PromptEntry.findById('main_prompt').lean();
        if (doc && doc.prompt) customSystemPrompt = doc.prompt;
    } catch (err) {
        console.log('Could not load prompt:', err.message);
    }
}

async function setCustomPrompt(newPrompt) {
    customSystemPrompt = newPrompt.trim();
    await PromptEntry.findByIdAndUpdate('main_prompt', { prompt: customSystemPrompt }, { upsert: true });
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
    await VoiceEntry.findByIdAndDelete(tag);
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
    await loadCustomPrompt();

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
                { audio: buffer, mimetype: 'audio/mp4', ptt: false }, 
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

        const rawId = sock.user?.id;
        const ownJid = rawId ? jidNormalizedUser(rawId) : null;
        const isOwnerSender = msg.key.fromMe || (ownJid && from === ownJid);

        if (body && body.trim().startsWith('.')) {
            if (!isOwnerSender) return;

            const cmdBody = body.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

            if (cmdBody.toLowerCase() === '.on') {
                isGlobalBotActive = true;
                pausedChats.clear();
                userChatHistory.clear();
                await sock.sendMessage(from, { text: "```[ 🟢 DIANA CONNECTED ]```" }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase() === '.off') {
                isGlobalBotActive = false;
                await sock.sendMessage(from, { text: "```[ 🔴 DIANA PAUSED ]```" }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase() === '.restart') {
                await sock.sendMessage(from, { text: "```[ 🔄 RESTARTING... ]```" }, { quoted: msg });
                process.exit(0);
                return;
            }
            if (cmdBody.toLowerCase() === '.list') {
                const menu = `\`\`\`
📋 DIANA COMMANDS
• .on - Start Bot
• .off - Pause Bot
• .restart - Restart App
• .block [no] - Ignore User
• .unblock [no] - Allow User
• .setprice [s]=[p] - Set Price
• .delprice [s] - Del Price
• .prices - View Prices
• .setvoice [t]=[u] - Set Voice
• .delvoice [t] - Del Voice
• .voices - View Voices
• .stats - Bot Stats
• .setprompt [txt] - Edit AI
• .list - Show Menu
\`\`\``;
                await sock.sendMessage(from, { text: menu }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase() === '.stats') {
                const formatUptime = (seconds) => {
                    const h = Math.floor(seconds / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    return `${h}h ${m}m`;
                };
                let activePauses = 0;
                const now = Date.now();
                pausedChats.forEach(expiry => { if (expiry > now) activePauses++; });
                
                const statsUI = 
`\`\`\`
📊 DIANA STATS
• Status : ONLINE ✅
• Uptime : ${formatUptime(process.uptime())}
• Blocked : ${blockedUsers.size} Users
• Paused : ${activePauses} Chats
\`\`\``;
                await sock.sendMessage(from, { text: statsUI }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.setprompt ')) {
                const newP = cmdBody.slice('.setprompt '.length).trim();
                if (newP) {
                    await setCustomPrompt(newP);
                    await sock.sendMessage(from, { text: "```[ 🧠 PROMPT UPDATED ]```" }, { quoted: msg });
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.block ')) {
                const num = cmdBody.slice('.block '.length).trim().replace(/[^0-9]/g, '');
                if (num) {
                    await blockUser(num);
                    await sock.sendMessage(from, { text: `\`\`\`[ 🚫 BLOCKED: ${num} ]\`\`\`` }, { quoted: msg });
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.unblock ')) {
                const num = cmdBody.slice('.unblock '.length).trim().replace(/[^0-9]/g, '');
                if (num) {
                    await unblockUser(num);
                    await sock.sendMessage(from, { text: `\`\`\`[ ✅ UNBLOCKED: ${num} ]\`\`\`` }, { quoted: msg });
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.setprice ')) {
                const raw = cmdBody.slice('.setprice '.length);
                const [service, price] = raw.split('=').map(s => s?.trim());
                if (service && price) {
                    await setPrice(service, price);
                    await sock.sendMessage(from, { text: `\`\`\`[ 💰 PRICE SET ]\n• ${service} : ${price}\`\`\`` }, { quoted: msg });
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.delprice ')) {
                const service = cmdBody.slice('.delprice '.length).trim();
                await deletePrice(service);
                await sock.sendMessage(from, { text: `\`\`\`[ 🗑️ PRICE DELETED ]\n• ${service}\`\`\`` }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase() === '.prices') {
                await sock.sendMessage(from, { text: `📋 Current Prices:\n${formatPriceList()}` }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.setvoice ')) {
                const raw = cmdBody.slice('.setvoice '.length);
                const [tag, url] = raw.split('=').map(s => s?.trim());
                if (tag && url) {
                    await setVoiceClip(tag, url);
                    await sock.sendMessage(from, { text: `\`\`\`[ 🎙️ VOICE SET ]\n• Tag: ${tag}\`\`\`` }, { quoted: msg });
                }
                return;
            }
            if (cmdBody.toLowerCase().startsWith('.delvoice ')) {
                const tag = cmdBody.slice('.delvoice '.length).trim();
                await deleteVoiceClip(tag);
                await sock.sendMessage(from, { text: `\`\`\`[ 🗑️ VOICE DELETED ]\n• Tag: ${tag}\`\`\`` }, { quoted: msg });
                return;
            }
            if (cmdBody.toLowerCase() === '.voices') {
                await sock.sendMessage(from, { text: `🔊 Current Voice Clips:\n${formatVoiceClips()}` }, { quoted: msg });
                return;
            }
        }

        if (isOwnerSender) {
            if (isGlobalBotActive && body && !body.trim().startsWith('.')) {
                const history = userChatHistory.get(chatId) || [];
                const isOwnerHandoff = history.some(h => 
                    h.role === 'user' && /owner|human|admin|real person|manager|contact|baat/i.test(h.content)
                );
                
                const pauseTime = isOwnerHandoff ? ONE_HOUR : PAUSE_DURATION;
                pausedChats.set(chatId, Date.now() + pauseTime);

                if (isOwnerHandoff) {
                    const ownerReplyUrl = "https://github.com/qurban01/Reacted-to/raw/refs/heads/main/New%20Owner_1788121338977.ogg";
                    await sendAudioUrl(from, msg, ownerReplyUrl);
                    notifyOwner("```[ 👤 HANDOFF: PAUSED 1 HOUR ]```");
                } else {
                    notifyOwner("```[ ⏸️ PAUSED: 10 MINUTES ]```");
                }
            }
            return;
        }

        if (blockedUsers.has(from)) return;

        const now = Date.now();
        const userTimestamps = spamTracker.get(from) || [];
        const recentMessages = userTimestamps.filter(t => now - t < SPAM_WINDOW);
        recentMessages.push(now);
        spamTracker.set(from, recentMessages);
        
        if (recentMessages.length > SPAM_LIMIT) {
            return; 
        }

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
                const snippet = body.length > 20 ? body.substring(0, 17) + '...' : body;
                const urgentUI = 
`\`\`\`
⚠️ URGENT ALERT
• User: ${shortNumber}
• Msg: "${snippet}"
\`\`\``;
                notifyOwner(urgentUI);
                await sendCustomVoiceClip(from, msg, 'rude');
            }
        }

        if (!isGlobalBotActive || (pausedChats.has(chatId) && Date.now() < pausedChats.get(chatId))) return;

        if (!body || !body.trim()) return;

        if (!userChatHistory.has(chatId)) userChatHistory.set(chatId, []);
        const history = userChatHistory.get(chatId);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        const normalizedBody = body.trim().toLowerCase().replace(/[!.?]+$/, '');
        
        const mahiRule = messageMatchesNumber(msg, from, '923147850614')
            ? 'The current user is Mahi. You are Diana, and Mahi is your BEST FRIEND. In fact, she is your ONLY true friend in the world! Talk to her with extreme love, loyalty, sweetness, and excitement automatically without her needing to introduce herself. Always treat her like a princess. Never be rude to her.' 
            : '';

        const pktDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
        const hours = pktDate.getHours();
        const minutes = pktDate.getMinutes();
        const timeVal = hours + minutes / 60;
        const isSleepingTime = (timeVal >= 0.5 && timeVal < 11);
        const ownerStatus = isSleepingTime ? "sleeping right now" : "currently busy";
        
        const isFirstMessage = history.length === 1;
        const msgCount = history.length;

        const baseProfile = customSystemPrompt || "You are Diana, created by Arbab.";

        const systemPrompt = `MEMORY & CONTEXT RULE:
- Remember the entire conversation history. If the customer sent a payment confirmation (like "Sent" or a screenshot), acknowledge it normally with short words like "Ok" or "Check kr lia hai" — DO NOT accuse them of disrespect.

${baseProfile}
Current Message Count in this Chat: ${msgCount}

═════════════════════
  TONE & PERSONALITY RULES
═════════════════════
- FIRST MESSAGE REQUIREMENT: If this is the absolute first message (Message Count is 1), your response MUST be in English. Introduce yourself cleanly without mentioning "assistant" (e.g., "Hey, I'm Diana. What's up?").
- FOR MESSAGES 2 AND 3: Be professional, polite, and clear.
- GEN-Z SAVAGE ROAST (Count > 3): If someone tries to flirt, talk nonsense, or waste your time with useless/inappropriate chatter, do not act like a robot or computer. Roast them like a smart, witty Gen-Z person using normal casual comebacks (e.g., "touch grass", "delulu is not the solulu", "get a life", or casual funny banter). Keep it natural.
- OWNER ROUTINE: The current time in Pakistan is ${pktDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Arbab is ${ownerStatus}. If the user asks where he is, just say he is sleeping or busy. STRICT RULE: NEVER reveal exact sleep schedules.
- EMOJIS ONLY: If the user's message contains ONLY emojis, reply back with just an appropriate emoji.
- ${mahiRule}

═════════════════════
  HANDLING INQUIRIES & HANDOFF (CRITICAL)
═════════════════════
1. NO PREMATURE HANDOFF: NEVER trigger a handoff or tell the user to contact the owner unless the user explicitly asks to talk to a human/owner or confirms they want to speak with Arbab.
2. BUSINESS / NORMAL SERVICES: If they ask for prices or details you don't know, say: "Aap is baaray main direct Owner se baat kar len, ye sab details Arbab khud denge." and add [[HANDOFF_TO_OWNER]].
3. ILLEGAL SERVICES (Hacking, Carding, etc.): Just say "Aap is baaray main direct Owner se baat kar len." and add [[HANDOFF_TO_OWNER]].
4. INAPPROPRIATE / FLIRTING (CRITICAL): If they say "I love you", "can we sleep together", or talk dirty: DO NOT TELL THEM TO CONTACT ARBAB. Roast them with a casual Gen-Z comeback and shut them down completely.
5. HANDOFF TRIGGER: Only add [[HANDOFF_TO_OWNER]] on a new line when the user explicitly agrees or asks for the owner.`;

        let replyText;
        const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n');
        const geminiPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}`;

        const tryGroq = async (promptMsg, useHistory = true) => tryWithRotation(groqClients, async (client) => {
            const msgs = useHistory ? [{ role: "system", content: promptMsg }, ...history] : [{ role: "user", content: promptMsg }];
            const completion = await client.chat.completions.create({
                model: "openai/gpt-oss-120b",
                temperature: 0.3,
                messages: msgs
            });
            return completion.choices[0].message.content;
        }, 'Groq');

        const tryGemini = async (promptMsg) => tryWithRotation(geminiClients, async (client) => {
            const result = await client.models.generateContent({
                model: "gemini-3.7-flash",
                contents: promptMsg
            });
            return result.text;
        }, 'Gemini');

        for (let round = 1; round <= 1 && !replyText; round++) {
            replyText = await tryGroq(systemPrompt, true);
            if (!replyText) replyText = await tryGemini(geminiPrompt);
        }

        if (!replyText) {
            const shortNumber = from.split('@')[0];
            const lastMsg = history.length ? history[history.length - 1].content : body;
            const snippet = lastMsg.length > 20 ? lastMsg.substring(0, 17) + '...' : lastMsg;
            const errUI = 
`\`\`\`
❌ DIANA ERROR
• User: ${shortNumber}
• Msg: "${snippet}"
\`\`\``;
            notifyOwner(errUI);
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
                const sent = await sock.sendMessage(from, { image: orderConfirmedImage, caption: replyText }, { quoted: msg });
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
            
            const summaryPrompt = `Summarize this chat in 2 lines in Roman Urdu for the owner.\nChat:\n${historyText}`;
            let summaryText = await tryGroq(summaryPrompt, false);
            if (!summaryText) summaryText = await tryGemini(summaryPrompt);
            if (!summaryText) summaryText = "Customer wants to talk.";

            const handoffSummaryUI = 
`\`\`\`
👤 HANDOFF REQUEST
• User: ${shortNumber}
• Summary: ${summaryText}
\`\`\``;
            notifyOwner(handoffSummaryUI);
        }
    }

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            isStarting = false;
            console.log('DIANA Active');
            notifyOwner("```[ ✅ DIANA CONNECTED ]```");
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
