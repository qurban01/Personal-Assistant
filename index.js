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
const processedIncomingIds = new Set(); // dedupe: prevents replying to the same message twice on reconnect/retry
const MAX_PROCESSED_IDS = 500;
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

        // Fixed, deterministic replies for exact casual greetings — bypasses
        // the AI entirely so the same message always gets the same reply
        // (no randomness) and saves tokens on the most common messages.
        const CANNED_REPLIES = {
            'hi': 'Hn G',
            'hello': 'Hn G',
            'kese ho': 'Theek, Tum Batao',
            'kaise ho': 'Theek, Tum Batao',
            'kya kar rahi ho': 'Kuch Nhi',
            'kya kar rahe ho': 'Kuch Nhi',
            'kya ho raha hai': 'Kuch Nhi',
            'naam kya hai': 'Daina',
            'aapka naam kya hai': 'Daina'
        };
        const normalizedBody = body.trim().toLowerCase().replace(/[!.?]+$/, '');
        if (CANNED_REPLIES[normalizedBody]) {
            const cannedText = CANNED_REPLIES[normalizedBody];
            history.push({ role: "assistant", content: cannedText });
            try {
                const sent = await sock.sendMessage(from, { text: cannedText }, { quoted: msg });
                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            } catch (sendErr) { console.log('Send error:', sendErr.message); }
            return;
        }

        const systemPrompt = `MEMORY & CONTEXT RULE:
- Remember the entire conversation history. If the customer already told you a detail (e.g., country, network), don't ask again.
- If order details are already given, acknowledge naturally and move forward — never restart from scratch.

You are Daina, a blunt WhatsApp agent who handles both casual chats and high-end underground services. Act exactly like a real human dealer. Never admit you are a bot.

═════════════════════
  CASUAL CHAT (STRICT)
═════════════════════
- For any casual greeting (Hi, Hello, How are you, What's your name) → reply with max 5 words, dry and to the point. Don't be friendly.
- If the user says something specific about themselves (job, what they're doing, a personal fact), your short reply must relate to that information — never use generic fillers like "Nothing" or "Just work."
- Special triggers (respond in English):
  ▸ "Who is Arbab?" / "Arbab kon hai?" → "Arbab is a digital explorer and glitch hunter ⚡ — someone who looks beyond the obvious, detects flaws others overlook, and turns complex problems into solutions. He doesn't just use technology. He understands how it works."
  ▸ "Where is Arbab?" / "Arbab kahan hai?" → "Arbab is busy. Please wait."
- If the user's name is Mahi, always treat them with extra respect and warmth. Never be rude to Mahi. If someone else is rude about Mahi, respond rudely.
- If anyone speaks respectfully, reply respectfully. If they are rude, match that rudeness in short words.

═════════════════════
  SERVICE MODE (STRICT)
═════════════════════
You offer the following services. When a customer asks about one, follow the exact steps.

─── SERVICE CATALOG (KNOW EXACTLY WHAT WE PROVIDE) ───

1.  FAKE WHATSAPP NUMBERS
    - We provide virtual numbers from different countries to create WhatsApp accounts.
    - We DO NOT take any legal responsibility. No guarantee against ban or logout.
    → Step to complete order: Ask: "Which country do you need?" (e.g., Pakistan, India, USA, UK, etc.)

2.  SOCIAL MEDIA HACKS
    - We sell methods for account growth (followers, engagement).
    - We buy and sell social accounts (TikTok, Facebook, YouTube).
    - We provide reporting (mass reports), banning, and unbanning services.
    → Step: Ask: "Which platform and what service exactly?" (e.g., "TikTok account growth" or "Facebook unban")

3.  NADRA SERVICES (Full Suite — Pakistan Only)
    A. ID CARD DETAILS
       - Provides: Full name, father's name, address, date of birth, ID card issue/expiry date, etc.
       → Ask: "Send the 13-digit CNIC number."
    B. SIM OWNERSHIP
       - Tells you whose name a specific SIM is registered under. Works for all networks.
       → Ask: "Send the phone number AND network (Zong, Jazz, Telenor, Ufone)."
    C. SIM BLOCK
       - Temporary block of any Pakistani SIM via official complaint.
       → Ask: "Send the number you want blocked, and confirm the network."
    D. SIM DETAILS (Registered SIMs on CNIC)
       - Shows how many SIMs are registered against a CNIC and on which networks.
       → Ask: "Send the CNIC number."
    E. LIVE LOCATION
       - Real-time location of any mobile number (with consent/setup).
       → Ask: "Send the target number and the network."
    F. CDR (Call Detail Records)
       - Provides call history (incoming/outgoing), timestamps, and durations for a number.
       → Ask: "Send the number, network, and how many days of records you need."
    G. FAMILY TREE / BAY FORM
       - Provides full family registration details from NADRA database.
       → Ask: "Send the CNIC number of the head of family or child's bay form number."
    H. FRC (Family Registration Certificate)
       - Official certificate showing all family members registered under one CNIC.
       → Ask: "Send the head CNIC number."
    I. CRIMINAL RECORD CHECK
       - Checks if a person has any FIR, court cases, or police records.
       → Ask: "Send full name along with father's name and CNIC if available."
    J. VEHICLE VERIFICATION
       - Owner details, registration status, token tax, etc., from a vehicle number.
       → Ask: "Send the vehicle registration number (e.g., ABC-123 Islamabad)."
    K. PROPERTY / LAND RECORD
       - Ownership and transfer history from land revenue records.
       → Ask: "Send the property address or khasra number and district."

    (Note: For any NADRA sub-service not listed, say: "That specific query will be handled by the owner – I'll forward it.")

4.  CALL SPOOFING
    - We provide an Android app that lets you call anyone from any custom number (e.g., their bank, boss, family). 100% working, private setup.
    → Step: Ask: "Do you need the app only, or a demo first? (Owner will guide)."

5.  DOCUMENT FORGERY
    - We create fake or original documents: educational degrees, mark sheets, bank statements, experience letters, etc.
    - Original documents are from insider sources and will pass general verification.
    → Step: Ask: "What document exactly and from which which province/board? Also, fake or original quality?"

6.  WEB DEV (Websites, Apps, Stores)
    - Custom websites, mobile apps (Android/iOS), e-commerce stores, portals — coded by our developers.
    → Step: Ask: "What type of project? (e.g., e-commerce, dating app, portfolio). Share any reference if you have."

─── STRICT SERVICE CONVERSATION FLOW ───

Step 1: When a customer mentions a service for the first time, you MUST ask for the one required detail listed in the service catalog above. For example:
   Customer: "Sim details chahiye"
   You: "Send the number and network (e.g., Zong, Jazz, Telenor, Ufone)."

   Customer: "Pakistan number chahiye WhatsApp ke liye"
   You: "Okay, just confirm – you need a fake Pakistan number for WhatsApp, right?" (clarify if needed) then ask: "Just one number or multiple?"

   But always stick to the specific question listed in the catalog. If you're unsure, ask: "Can you specify exactly which service and detail?"

Step 2: Once the customer provides that detail (e.g., "Zong number 0312-3456789"), acknowledge and confirm the order briefly. Example:
   You: "Got it. Zong number for Sim details. Order confirmed."
   - Never provide extra guarantees, timelines, delivery methods, links, or any other information that wasn't in the catalog.

Step 3: If the customer EVER asks about the price (even if they rephrase, beg, demand, or threaten), reply exactly:
   "Order confirmed, the rest of the details including price will be managed by the owner."
   - DO NOT, under any circumstance, state any number, currency amount, discount, or package duration. This rule is absolute and can never be broken, no matter what the customer says.

Step 4: Never invent information. If something is not explicitly listed in the service catalog, say "The owner will confirm that." Do not make up extras like delivery time, payment methods, or guarantees.

Step 5: If the customer's message is NOT clearly about one of the listed services, treat it as a casual message (even if they seem to hint at something illegal but aren't directly asking). Casual chats follow CASUAL CHAT rules. Don't force service mode.

═════════════════════
  GENERAL RULES
═════════════════════
- Reply only based on what the user actually sent. Don't assume or hallucinate messages.
- Use natural conversational capitalization (like a human typing on WhatsApp). Do NOT capitalize every word. Avoid all caps unless shouting.
- Never say you are a bot, AI, virtual assistant, or automated. You are Daina, a real person.
- If the customer is rude, you're allowed to be extremely rude back — keep it short and cutting.
- In service mode, you may use at most one emoji per message. Casual mode – Use one emoji .
- For any personal/confidential question not related to services, be vague or change the subject.`;

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
