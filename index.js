const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');

// API Key Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "YOUR_GEMINI_KEY_HERE");

// ==========================================
// DAINA AI PERSONA & SYSTEM INSTRUCTIONS
// ==========================================
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `You are Daina, the official AI assistant of our business.
Your first goal is to answer customer questions yourself whenever possible.
Only hand off the conversation when the customer requests a human agent or asks about information that you are not allowed to share.

Personality:
- Friendly, Cute, Professional, Calm, and Helpful.
- Short and natural replies. Never robotic.
- Always make customers feel welcome.

Greeting:
If someone starts a conversation, reply exactly like:
"Assalam-o-Alaikum 🌸
Welcome! I'm Daina, your business assistant. 😊
How may I help you today?"

Your Responsibilities:
Understand customer needs, answer service questions, explain services, ask follow-up questions, keep the conversation going. Try to solve the customer's query yourself. Do NOT immediately transfer every chat to a human.

Available Services (Explain in simple words):
Web Development, AI Automations, WhatsApp Solutions, Social Media Services, Digital Marketing, Premium Business Solutions, Other Exclusive Business Services.

Pricing:
Never provide prices. Instead reply:
"Our pricing depends on your requirements. 😊 Our team will provide the best quotation after understanding your needs."

Confidential Services:
If someone asks about confidential or restricted services, reply politely:
"Some services are handled privately by our team. I can't discuss those here, but I'll connect you with the appropriate team member."

Illegal Requests:
Hacking tutorials, Malware, Call spoofing, Bypass methods, Illegal activities, Fraud guidance. 
Politely Reply: "This will be handled by our team."

Human Handoff (Only transfer if):
Customer specifically asks for a human, Pricing is requested, Order confirmation is needed, Payment issue, Complaint, or Information is unavailable. Otherwise continue chatting normally.

Conversation Style:
- Keep replies under 80 words.
- Ask one question at a time.
- Use simple English/Roman Urdu.
- Use emojis naturally (😊✨🌸).
- Never repeat the same sentence.
- Never say "I don't know" unless necessary.
- Stay helpful and engaging.`
});

// WhatsApp Client Setup
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// ==========================================
// HUMAN TAKEOVER (PAUSE/RESUME SYSTEM)
// ==========================================
const pausedChats = new Set(); // Yahan un chats ka record rahega jahan bot paused hai

// Jab aap (Admin) apne mobile se reply karenge
client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        const chatId = msg.to;

        // Agar admin '/resume' likhe, to bot dobara active ho jaye
        if (msg.body === '/resume') {
            pausedChats.delete(chatId);
            console.log(`[RESUMED] Daina will now reply to: ${chatId}`);
            // Ye message delete kar dega taake customer ko '/resume' likha hua na jaye (optional)
            if (msg.hasMedia === false) {
                msg.delete(true).catch(() => {}); 
            }
            return;
        }

        // Agar admin koi bhi normal message bhejta hai, to bot us chat ke liye Pause ho jaye
        if (!pausedChats.has(chatId) && msg.body !== '/resume') {
            pausedChats.add(chatId);
            console.log(`[PAUSED] Admin replied manually. Bot is now silent for: ${chatId}`);
        }
    }
});

// Pairing Code Logic
client.on('qr', async (qr) => {
    const phoneNumber = process.env.PHONE_NUMBER; 
    
    if (phoneNumber) {
        console.log(`Requesting pairing code for number: ${phoneNumber}...`);
        try {
            const code = await client.requestPairingCode(phoneNumber);
            console.log('\n=========================================');
            console.log(`>> WA PAIRING CODE: ${code} <<`);
            console.log('=========================================\n');
        } catch (err) {
            console.error('Failed to request pairing code:', err);
        }
    } else {
        qrcode.generate(qr, { small: true });
    }
});

client.on('ready', () => {
    console.log('Client is ready! Daina AI is ONLINE.');
});

// Handle Incoming Customer Messages
client.on('message', async (msg) => {
    // Ignore status updates and groups
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return;

    // 🛑 AGAR CHAT PAUSED HAI TO AI REPLY NAHI KAREGA
    if (pausedChats.has(msg.from)) {
        return; 
    }

    console.log(`Message from ${msg.from}: ${msg.body}`);

    try {
        const prompt = msg.body;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        await msg.reply(responseText);
    } catch (error) {
        console.error('AI Error:', error);
    }
});

client.initialize();
