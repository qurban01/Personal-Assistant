const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini API Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Bot Status (Manual Reply Pause System)
let isBotActive = true;

// WhatsApp Client Setup (Heroku Buildpack Path)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.GOOGLE_CHROME_BIN || process.env.CHROME_BIN,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote'
        ]
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('QR Code generated. Agar scan nahi karna to neeche aane wale Pairing Code ka intezar karein.');
});

client.on('ready', () => {
    console.log('==========================================');
    console.log('DAINA AI IS READY AND CONNECTED! 🚀');
    console.log('==========================================');
});

client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        if (msg.body.toLowerCase() === '!bot on') {
            isBotActive = true;
            console.log('Bot dobara ACTIVE kar diya gaya hai.');
        } else if (msg.body.toLowerCase() === '!bot off') {
            isBotActive = false;
            console.log('Bot PAUSED kar diya gaya hai.');
        } else if (isBotActive && !msg.body.startsWith('!')) {
            isBotActive = false;
            console.log('Aapka manual message detect hua hai. Bot ab PAUSED hai. Dobara chalane ke liye "!bot on" likhein.');
        }
        return; 
    }

    if (msg.isStatus || msg.from.includes('@g.us')) return;
    if (!isBotActive) return;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const systemPrompt = `You are Daina, an AI-powered WhatsApp assistant. 
        Your tone is friendly, helpful, and professional. 
        Introduce our services politely when asked. 
        CRITICAL RULE: If the user asks about pricing or costs, do NOT give numbers. Always reply with exactly: "Please contact my owner for specific pricing details."
        Keep responses concise and easy to read on WhatsApp.`;

        const prompt = `${systemPrompt}\n\nUser Message: ${msg.body}`;
        const result = await model.generateContent(prompt);
        const response = result.response.text();

        await msg.reply(response);
    } catch (error) {
        console.error('Error generating AI response:', error);
    }
});

client.initialize();

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
