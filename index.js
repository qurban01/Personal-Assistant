const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Prevent the whole process from crashing on the known wwebjs-mongo
// "RemoteAuth.zip ENOENT" race-condition error. Instead of dying, we log
// it and let the client keep running (session will sync again on the
// next backup cycle).
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (ignored to keep process alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (ignored to keep process alive):', reason);
});

// Gemini API Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let isBotActive = true;
let pairingCodeRequested = false;

// Connect to MongoDB first, then start WhatsApp client
mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('MongoDB connected successfully.');
    const store = new MongoStore({ mongoose });

    // WhatsApp Client Setup (Session stored in MongoDB, survives Heroku restarts)
    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 60000 // minimum allowed value - saves session to DB every 1 min
        }),
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
                '--mute-audio',
                '--single-process',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate'
            ]
        }
    });

    // Automatic Pairing Code Generator
    client.on('qr', async (qr) => {
        if (process.env.PHONE_NUMBER && !pairingCodeRequested) {
            pairingCodeRequested = true;
            try {
                console.log('WhatsApp is ready! Fetching your Pairing Code...');
                const pairingCode = await client.requestPairingCode(process.env.PHONE_NUMBER);
                console.log(`\n==========================================`);
                console.log(`YOUR WA PAIRING CODE IS: ${pairingCode}`);
                console.log(`==========================================\n`);
            } catch (error) {
                console.log('Error getting pairing code:', error.message);
            }
        } else if (!process.env.PHONE_NUMBER) {
            console.log('⚠️ ALERT: PHONE_NUMBER missing in Heroku Config Vars! Number dalein (e.g., 923001234567)');
        }
    });

    client.on('remote_session_saved', () => {
        console.log('Session saved to MongoDB.');
    });

    client.on('ready', () => {
        console.log('==========================================');
        console.log('DAINA AI IS READY AND CONNECTED! 🚀');
        console.log('==========================================');
    });

    client.on('auth_failure', (msg) => {
        console.log('AUTH FAILURE:', msg);
    });

    client.on('disconnected', (reason) => {
        console.log('Client was disconnected:', reason);
    });

    // Message Handling & Group Filter
    client.on('message_create', async (msg) => {
        const messageTime = msg.timestamp * 1000;
        if (Date.now() - messageTime > 60000) return;

        // Groups aur Status ko mukammal ignore karna
        if (msg.isStatus || msg.from.includes('@g.us')) return;

        if (msg.fromMe) {
            if (msg.body.toLowerCase() === '!bot on') {
                isBotActive = true;
                console.log('Bot dobara ACTIVE kar diya gaya hai.');
            } else if (msg.body.toLowerCase() === '!bot off') {
                isBotActive = false;
                console.log('Bot PAUSED kar diya gaya hai.');
            } else if (isBotActive && !msg.body.startsWith('!')) {
                isBotActive = false;
                console.log('Manual message detected. Bot PAUSED.');
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

}).catch((err) => {
    console.error('MongoDB connection failed:', err.message);
});
