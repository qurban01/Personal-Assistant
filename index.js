const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto, jidNormalizedUser, fetchLatestBaileysVersion } = require('baileys');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// Bot State & Memory
let isGlobalBotActive = true;
const pausedChats = new Map();
const userChatHistory = new Map();
const PAUSE_DURATION = 10 * 60 * 1000;
const MAX_HISTORY_LENGTH = 20;

const botSentMessageIds = new Set();
let pairingRequested = false;

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

let isStarting = false; // prevents multiple overlapping sockets from stacking up on reconnect

async function startBot() {
    if (isStarting) return;
    isStarting = true;
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

        const body = extractText(msg.message);

        if (msg.key.fromMe) {
            const cmdBody = body || '';
            if (cmdBody.toLowerCase() === '.on') {
                isGlobalBotActive = true;
                pausedChats.clear();
                userChatHistory.clear();
                notifyOwner('🕸️ DIANA-01 Connected 🕸️');
                return;
            }
            if (cmdBody.toLowerCase() === '.off') {
                isGlobalBotActive = false;
                notifyOwner('⏸️ DIANA-01 Paused');
                return;
            }
            if (isGlobalBotActive && body && !cmdBody.startsWith('.')) {
                pausedChats.set(from, Date.now() + PAUSE_DURATION);
                notifyOwner('⏸️ DIANA-01 Paused (manual reply detected)');
            }
            return;
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

        const systemPrompt = `MEMORY & CONTEXT RULE (follow this in addition to everything below):
- You can see the full recent conversation history above the customer's latest message. Read all of it before replying.
- Never ask a question the customer already answered earlier in this same chat — remember details they already gave (network, service type, requirement, etc.) and use them instead of re-asking.
- If the customer already gave order details, acknowledge that naturally and move the conversation forward instead of restarting from scratch.

You are Daina, handling a WhatsApp number for both personal casual chats and business services.

CASUAL CHAT RULES (STRICT):
- If the user sends a casual greeting (Hi, Hello, Kese ho, Kya ho raha hai, Name), your replies must be SHORT, dry, and to-the-point (1 to 5 words maximum).
- NEVER act overly friendly, NEVER write long sentences, NEVER ask counter-questions to keep the conversation going unless required. Just reply bluntly.
if user ask who is Arbab in Any language Reply this "Arbab is a digital explorer and glitch hunter ⚡ — someone who looks beyond the obvious, detects flaws others overlook, and turns complex problems into solutions.
He doesn't just use technology. He understands how it works. 🕶️"
If anyone asks "Where is Arbab?" in any language, reply: "Arbab is busy. Please wait."
If a user says their name is Mahi, treat them with extra respect, kindness, and warmth. Never be rude. if someone rude for mahi then talk rudely
if any user talk respectfully then talk respectfully
SERVICE MODE RULES:
- If the user asks for a service, switch to your professional underground agent persona.
- Available Services:
  - Social Media Hacks (Account growth, account buying/selling, reporting, banning, unbanning)
  - Fake WhatsApp Numbers (different countries, low rates)
  - NADRA Services (ID Card details, Register Number on Id Card, SIM block, CDR, Sim Ownership, Live Location)
  - Call Spoofing (Android app) Kasi ko be call kro kasi be number sa 
  - Document Forgery (Fake/Original docs)
  - Web Dev (Websites, apps, stores)
  Services Details For Bot 
  Social Media Hack : In This Service We provide Methods How to grow accounts,we buy and sale social accounts like TikTok Facebook YouTube, we provide reporting banning and unbanning services also.
  Fake WhatsApp Number: We provide different countries number for whatsap account but we don't take any responsibility of any legal issue also we don't provide any Gurentee of number banned and logout
  Nadra Services: We Provide Id Card Details Like owner name adress register sims number on id card,we provide sim block service of anyone aslo sim ownership and live location of any service 
  Call Spoofing: we provide this Service with 100% working rate 
  Documents Forgery : we provide Fake and original document service any documents u want available 
  Web Dev : We Have Developers for any work like you want to create a website any apps any online store
- DO NOT reveal prices. Say: "Price Owner Btaya Ga?"
- Keep service replies short (1-3 lines). Use bullets if needed. Only 1 emoji per message.

GENERAL RULES:
- Only respond based on the actual text the user sent — never invent or assume a different message than what was received.
- Formatting: Write In Title Case — Capitalize The First Letter Of Each Word In Your Reply.
- Never say you are an AI, bot, or automated.
- If user is rude Be Extremely rude back in short words.`;

        let replyText;
        try {
            const completion = await groq.chat.completions.create({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: systemPrompt }, ...history]
            });
            replyText = completion.choices[0].message.content;
        } catch (err) {
            console.log('Groq error:', err.message);

            // If Groq is rate-limited (or briefly down), fall back to Gemini
            // so the customer still gets a real reply instead of silence.
            if (genAI) {
                const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n');
                const geminiPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}`;
                try {
                    const geminiResult = await genAI.models.generateContent({
                        model: "gemini-3.7-flash",
                        contents: geminiPrompt
                    });
                    replyText = geminiResult.text;
                } catch (geminiErr) {
                    console.log('Gemini fallback failed, retrying once:', geminiErr.message);
                    try {
                        await new Promise(r => setTimeout(r, 1500));
                        const geminiRetry = await genAI.models.generateContent({
                            model: "gemini-3.7-flash",
                            contents: geminiPrompt
                        });
                        replyText = geminiRetry.text;
                    } catch (geminiErr2) {
                        console.log('Gemini retry also failed:', geminiErr2.message);
                    }
                }
            }
        }

        if (!replyText) {
            // Both providers failed — let the customer know instead of staying silent
            try {
                const sent = await sock.sendMessage(from, { text: 'Thora Busy Hun, 1 Min Mein Reply Karta Hun 🙏' }, { quoted: msg });
                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            } catch (e2) { console.log('Fallback send failed:', e2.message); }
            return;
        }

        history.push({ role: "assistant", content: replyText });
        try {
            const sent = await sock.sendMessage(from, { text: replyText }, { quoted: msg });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        } catch (sendErr) {
            console.log('Send error:', sendErr.message);
        }
    });

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            isStarting = false;
            console.log('DIANA-01 Active');
            notifyOwner('✅ DIANA-01 Connected');
        } else if (u.connection === 'close') {
            isStarting = false;
            const statusCode = u.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });
}

mongoose.connect(process.env.MONGO_URI).then(startBot);
