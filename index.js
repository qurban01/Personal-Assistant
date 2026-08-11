const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "YOUR_GEMINI_KEY_HERE");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
    console.log('Client is ready! Your AI Bot is now ONLINE.');
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return;

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

