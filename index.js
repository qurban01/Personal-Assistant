const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini API Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Bot Status (Manual Reply Pause System)
let isBotActive = true;

// WhatsApp Client Setup (Hardcoded Path & MEMORY OPTIMIZATION FIX)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Exact Heroku Chrome Path
        executablePath: process.env.CHROME_BIN || process.env.GOOGLE_CHROME_BIN || '/app/.chrome-for-testing/chrome-linux64/chrome',
        // Extreme Memory Saving Arguments for Heroku 512MB Limit
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--single-process', 
            '--mute-audio'
        ]
    }
});

// Generate QR Code ya Pairing Code (Logs mein dekhne ke liye)
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('QR Code generated. Agar scan nahi karna to neeche aane wale Pairing Code ka intezar karein.');
});

// Jab bot successfully connect ho jaye
client.on('ready', () => {
    console.log('==========================================');
    console.log('DAINA AI IS READY AND CONNECTED! 🚀');
    console.log('==========================================');
});

// Message Handling & Daina Persona
client.on('message_create', async (msg) => {
    // 1. MANUAL PAUSE SYSTEM: Agar aap khud reply karte hain
    if (msg.fromMe) {
        if (msg.body.toLowerCase() === '!bot on') {
            isBotActive = true;
            console.log('Bot dobara ACTIVE kar diya gaya hai.');
        } else if (msg.body.toLowerCase() === '!bot off') {
            isBotActive = false;
            console.log('Bot PAUSED kar diya gaya hai.');
        } else if (isBotActive && !msg.body.startsWith('!')) {
            // Agar aap koi aam message bhejte hain, to bot khud-ba-khud pause ho jayega
            isBotActive = false;
            console.log('Aapka manual message detect hua hai. Bot ab PAUSED hai. Dobara chalane ke liye "!bot on" likhein.');
        }
        return; 
    }

    // Status updates ya group messages ko ignore karna
    if (msg.isStatus || msg.from.includes('@g.us')) return;

    // Agar bot paused hai, to koi reply nahi karega
    if (!isBotActive) return;

    try {
        // Gemini AI Model Initialize
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Daina AI Persona (System Prompt)
        const systemPrompt = `You are Daina, an AI-powered WhatsApp assistant. 
        Your tone is friendly, helpful, and professional. 
        Introduce our services politely when asked. 
        CRITICAL RULE: If the user asks about pricing or costs, do NOT give numbers. Always reply with exactly: "Please contact my owner for specific pricing details."
        Keep responses concise and easy to read on WhatsApp.`;

        const prompt = `${systemPrompt}\n\nUser Message: ${msg.body}`;

        // Generate response from Gemini
        const result = await model.generateContent(prompt);
        const response = result.response.text();

        // Send reply to user
        await msg.reply(response);
        console.log(`Reply sent to ${msg.from}`);

    } catch (error) {
        console.error('Error generating AI response:', error);
    }
});

// Client Start
client.initialize();

// Heroku Pairing Code Request (Phone Number se)
if (process.env.PHONE_NUMBER) {
    setTimeout(async () => {
        try {
            const pairingCode = await client.requestPairingCode(process.env.PHONE_NUMBER);
            console.log(`\n==========================================`);
            console.log(`YOUR WA PAIRING CODE IS: ${pairingCode}`);
            console.log(`==========================================\n`);
        } catch (error) {
            console.log('Pairing code requested or already authenticated.');
        }
    }, 5000); 
}
