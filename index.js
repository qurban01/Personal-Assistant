const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini API Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Bot Status
let isBotActive = true;

// WhatsApp Client Setup (Hardcoded Path & MEMORY FIX)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.CHROME_BIN || process.env.GOOGLE_CHROME_BIN || '/app/.chrome-for-testing/chrome-linux64/chrome',
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
            '--mute-audio',
            '--disk-cache-size=0'
        ]
    }
});

client.on('ready', () => {
    console.log('==========================================');
    console.log('DAINA AI IS READY AND CONNECTED! 🚀');
    console.log('==========================================');
});

// Message Handling
client.on('message_create', async (msg) => {
    // 🚨 1. Purani chats ko ignore karein jab WhatsApp sync ho raha ho (RAM bachane ke liye)
    const messageTime = msg.timestamp * 1000;
    if (Date.now() - messageTime > 60000) return; 

    // 🚨 2. Groups aur Status ko hamesha ignore karein
    if (msg.isStatus || msg.from.includes('@g.us')) return;

    // 3. Manual Pause System
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
        console.log(`Reply sent to ${msg.from}`);

    } catch (error) {
        console.error('Error generating AI response:', error);
    }
});

client.initialize();
