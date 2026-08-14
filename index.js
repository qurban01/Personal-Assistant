const makeWASocket = require('baileys').default;
const { DisconnectReason, Browsers, initAuthCreds, BufferJSON, proto } = require('baileys');
const mongoose = require('mongoose');
const { GoogleGenAI } = require('@google/genai');

// Gemini API Setup
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let isBotActive = true;
const botSentMessageIds = new Set();
let pairingRequested = false;

// ===== MongoDB-backed auth state for Baileys =====
// Each auth key (creds, signal keys, etc.) is stored as its own small
// document, so there is no zip/compress step and no ENOENT-style bugs.
async function useMongoAuthState(sessionId) {
    const AuthKeySchema = new mongoose.Schema({
        _id: String,
        value: String
    }, { collection: 'baileys_auth' });

    const AuthKey = mongoose.models.AuthKey || mongoose.model('AuthKey', AuthKeySchema);

    const readData = async (key) => {
        const doc = await AuthKey.findById(`${sessionId}:${key}`).lean();
        if (!doc) return null;
        try {
            return JSON.parse(doc.value, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const writeData = async (key, data) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await AuthKey.findByIdAndUpdate(
            `${sessionId}:${key}`,
            { value },
            { upsert: true }
        );
    };

    const removeData = async (key) => {
        await AuthKey.findByIdAndDelete(`${sessionId}:${key}`);
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}

// ===== Main bot =====
async function startBot() {
    const { state, saveCreds } = await useMongoAuthState('daina-session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome')
    });

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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('Logged out. Delete the session in MongoDB and pair again.');
            }
        } else if (connection === 'open') {
            console.log('==========================================');
            console.log('DAINA AI IS READY AND CONNECTED! 🚀');
            console.log('==========================================');
        }
    });

    // Message handling
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (!from || from.endsWith('@g.us') || from === 'status@broadcast') return;

        const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        if (msg.key.fromMe) {
            // Ignore the bot's own auto-replies — otherwise the bot
            // would detect its own reply as a "manual message" and pause itself.
            if (botSentMessageIds.has(msg.key.id)) {
                botSentMessageIds.delete(msg.key.id);
                return;
            }

            if (body.toLowerCase() === '!bot on') {
                isBotActive = true;
                console.log('Bot dobara ACTIVE kar diya gaya hai.');
            } else if (body.toLowerCase() === '!bot off') {
                isBotActive = false;
                console.log('Bot PAUSED kar diya gaya hai.');
            } else if (isBotActive && !body.startsWith('!')) {
                isBotActive = false;
                console.log('Manual message detected. Bot PAUSED.');
            }
            return;
        }

        if (!isBotActive) return;

        try {
            const systemPrompt = `You are Daina, an AI-powered WhatsApp assistant. 
            Your tone is friendly, helpful, and professional. 
            Introduce our services politely when asked. 
            CRITICAL RULE: If the user asks about pricing or costs, do NOT give numbers. Always reply with exactly: "Please contact my owner for specific pricing details."
            Keep responses concise and easy to read on WhatsApp.`;

            const prompt = `${systemPrompt}\n\nUser Message: ${body}`;
            const result = await genAI.models.generateContent({
                model: "gemini-3.7-flash",
                contents: prompt
            });

            const sent = await sock.sendMessage(from, { text: result.text });
            if (sent?.key?.id) {
                botSentMessageIds.add(sent.key.id);
            }
            console.log(`Reply sent to ${from}`);
        } catch (error) {
            console.error('Error generating AI response:', error);
        }
    });
}

mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('MongoDB connected successfully.');
    startBot();
}).catch((err) => {
    console.error('MongoDB connection failed:', err.message);
});
