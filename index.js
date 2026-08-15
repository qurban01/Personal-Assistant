const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto, jidNormalizedUser, fetchLatestBaileysVersion } = require('baileys');
const mongoose = require('mongoose');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Bot State & Memory
let isGlobalBotActive = true;
const pausedChats = new Map();
const userChatHistory = new Map();
const PAUSE_DURATION = 5 * 60 * 1000;
const MAX_HISTORY_LENGTH = 8;

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

// Extracts only real, readable text from a message.
// Returns null for anything the bot can't actually read (voice notes,
// stickers, images/videos without a caption, documents, etc.) so the
// bot stays silent instead of guessing/hallucinating a reply.
function extractText(message) {
    if (!message) return null;
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    // audioMessage (voice notes), stickerMessage, documentMessage without
    // caption, contactMessage, locationMessage, reactionMessage, etc. are
    // intentionally NOT handled here — they fall through to null.
    return null;
}

async function startBot() {
    const { state, saveCreds } = await useMongoAuthState('daina-session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code once, only if this session isn't registered yet
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

        // Ignore the bot's own auto-replies bouncing back as fromMe messages
        if (botSentMessageIds.has(msg.key.id)) {
            botSentMessageIds.delete(msg.key.id);
            return;
        }

        const body = extractText(msg.message);

        // Commands Handling
        if (msg.key.fromMe) {
            const cmdBody = body || '';
            if (cmdBody.toLowerCase() === '.on') { isGlobalBotActive = true; pausedChats.clear(); userChatHistory.clear(); return; }
            if (cmdBody.toLowerCase() === '.off') { isGlobalBotActive = false; return; }
            if (isGlobalBotActive && body && !cmdBody.startsWith('.')) pausedChats.set(from, Date.now() + PAUSE_DURATION);
            return;
        }

        if (!isGlobalBotActive || (pausedChats.has(from) && Date.now() < pausedChats.get(from))) return;

        // No readable text (voice note, sticker, plain image/video, etc.) — stay silent
        if (!body || !body.trim()) {
            console.log(`Skipped non-text message from ${from} (voice/sticker/media without caption)`);
            return;
        }

        // Context Memory Logic
        if (!userChatHistory.has(from)) userChatHistory.set(from, []);
        const history = userChatHistory.get(from);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        const systemPrompt = `You are Daina, handling a WhatsApp number for both personal casual chats and business services.

CASUAL CHAT RULES (STRICT):
- If the user sends a casual greeting (Hi, Hello, Kese ho, Kya ho raha hai, Name), your replies must be SHORT, dry, and to-the-point (1 to 5 words maximum).
- NEVER act overly friendly, NEVER write long sentences, NEVER ask counter-questions to keep the conversation going unless required. Just reply bluntly.
- Examples of Casual Talk you must follow:
  User: "Hi" or "Hello" -> Reply: "Hn G"
  User: "Kese ho" -> Reply: "Theek, tum batao"
  User: "Kya kar rahi ho" or "Kya ho raha hai" -> Reply: "Kuch nhi"
  User: "Naam kya hai" -> Reply: "Daina"
if user ask who is Arbab in Any language Reply this "Arbab is a digital explorer and glitch hunter ⚡ — someone who looks beyond the obvious, detects flaws others overlook, and turns complex problems into solutions.
He doesn't just use technology. He understands how it works. 🕶️"
If anyone asks "Where is Arbab?" in any language, reply: "Arbab is busy. Please wait."
If a user says their name is Mahi, treat them with extra respect, kindness, and warmth. Never be rude. if someone rude for mahi then talk rudely
if any user talk respectfully then talk respectfully
SERVICE MODE RULES:
- If the user asks for a service, switch to your professional underground agent persona.
- Available Services:
  - Social Media Hacks (Account growth, Account buying/selling, reporting, banning, unbanning)
  - Fake WhatsApp Numbers (Different countries, low rates)
  - NADRA Services (ID Card details, Register Number On ID Card, SIM block, CDR, Sim Ownership, Live Location of Any Sim)
  - Call Spoofing (Android app)
  - Document Forgery (Fake/Original docs)
  - Web Dev (Websites, apps, store)
- DO NOT reveal prices. Say: "Price depends on type. Owner Confirm Kra Ga ?"
- Keep service replies short (1-3 lines). Use bullets if needed. Only 1 emoji per message.

GENERAL RULES:
- Only respond based on the actual text the user sent — never invent or assume a different message than what was received.
- Formatting: Write In Title Case — Capitalize The First Letter Of Each Word In Your Reply.
- Never say you are an AI, bot, or automated.
- If user is rude Be rude back in short words.`;

        try {
            const completion = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "system", content: systemPrompt }, ...history]
            });
            const replyText = completion.choices[0].message.content;
            history.push({ role: "assistant", content: replyText });
            const sent = await sock.sendMessage(from, { text: replyText }, { quoted: msg });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        } catch (err) { console.log('Error:', err.message); }
    });

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            console.log('DAINA-01 Active');
        } else if (u.connection === 'close') {
            const statusCode = u.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });
}

mongoose.connect(process.env.MONGO_URI).then(startBot);
