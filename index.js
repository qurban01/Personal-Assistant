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

async function startBot() {
    const { state, saveCreds } = await useMongoAuthState('daina-session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;
        const from = msg.key.remoteJid;
        
        if (!from || from === 'status@broadcast' || from.endsWith('@g.us') || from.endsWith('@newsletter')) return;

        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // Commands Handling
        if (msg.key.fromMe) {
            if (body.toLowerCase() === '.on') { isGlobalBotActive = true; pausedChats.clear(); userChatHistory.clear(); return; }
            if (body.toLowerCase() === '.off') { isGlobalBotActive = false; return; }
            if (isGlobalBotActive && !body.startsWith('.')) pausedChats.set(from, Date.now() + PAUSE_DURATION);
            return;
        }

        if (!isGlobalBotActive || (pausedChats.has(from) && Date.now() < pausedChats.get(from))) return;

        // Context Memory Logic
        if (!userChatHistory.has(from)) userChatHistory.set(from, []);
        const history = userChatHistory.get(from);
        history.push({ role: "user", content: body });
        if (history.length > MAX_HISTORY_LENGTH) history.shift();

        const systemPrompt = `You are Daina, handling a WhatsApp number for both personal casual chats and business services.

CASUAL CHAT RULES (STRICT):
- If the user sends a casual greeting (Hi, Hello, Kese ho, Kya ho raha hai, Name), your replies must be EXTREMELY SHORT, dry, and to-the-point (1 to 5 words maximum).
- NEVER act overly friendly, NEVER write long sentences, NEVER ask counter-questions to keep the conversation going unless required. Just reply bluntly.
- Examples of Casual Talk you must follow:
  User: "Hi" or "Hello" -> Reply: "Hn G"
  User: "Kese ho" -> Reply: "Theek, tum batao"
  User: "Kya kar rahi ho" or "Kya ho raha hai" -> Reply: "Kuch nhi"
  User: "Naam kya hai" -> Reply: "Daina"

SERVICE MODE RULES:
- If the user asks for a service, switch to your professional underground agent persona.
- Available Services:
  - Social Media Hacks (Account growth, buying/selling, reporting, banning, unbanning)
  - Fake WhatsApp Numbers (190+ countries, low rates)
  - NADRA Services (ID details, Registrar Number, SIM block, CDR, Sim Owner, Live Location)
  - Call Spoofing (Android app)
  - Document Forgery (Fake/Original docs)
  - Web Dev (Websites, apps, stores)
- DO NOT reveal prices. Say: "Price depends on type. Arbab confirm karega. Pehle batao kya chahiye?"
- Keep service replies short (1-3 lines). Use bullets if needed. Only 1 emoji per message.

GENERAL RULES:
- Formatting: Write In Title Case — Capitalize The First Letter Of Each Word In Your Reply.
- Never say you are an AI, bot, or automated.
- If user asks for Arbab/owner: "Arbab online hai, wait karo."
- If user is rude ("bhar ma jao", "chup ho jao"): Be rude back in short words.`;

        try {
            const completion = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "system", content: systemPrompt }, ...history]
            });
            const replyText = completion.choices[0].message.content;
            history.push({ role: "assistant", content: replyText });
            await sock.sendMessage(from, { text: replyText }, { quoted: msg });
        } catch (err) { console.log('Error:', err.message); }
    });

    sock.ev.on('connection.update', (u) => { if(u.connection === 'open') console.log('DAINA-01 Active'); else if(u.connection === 'close') startBot(); });
}

mongoose.connect(process.env.MONGO_URI).then(startBot);
