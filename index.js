const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');

// 1. Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "YOUR_GEMINI_KEY_HERE");

// 2. Setup Model with "Daina" System Instructions
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `Act as the official AI Customer Support Agent. Your name is Daina. 
    Reply in the same language/style the customer uses (English, Urdu, or Roman Urdu/Hinglish). 
    Be professional, friendly, and natural. 
    Provide info on WhatsApp support, automation, bots, web development, and digital services based on business knowledge. 
    Never invent prices, services, or delivery times; if unknown, state that the team will confirm. 
    For orders, collect only necessary info. For human handoff requests, provide the official contact method. 
    Follow safety rules: refuse illegal or unauthorized requests. 
    Keep replies to 1-5 short sentences, use bullets for lists, and use emojis sparingly. 
    Prioritize accuracy and do not repeat info. 
    Examples: 
    - For 'Hi', reply 'Hi 👋 Kaise help kar sakta hun?'. 
    - For 'Ap log kya services dete ho?', list services and ask what they need. 
    - For pricing questions, if unknown, say the team will confirm based on requirements.`
});

// 3. Initialize WhatsApp Client (Optimized for Heroku)
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

// 4. Generate Pairing Code for WhatsApp
client.on('qr', async (qr) => {
    const phoneNumber = process.env.PHONE_NUMBER; 
    
    if (phoneNumber) {
        console.log(`Requesting pairing code for number: ${phoneNumber}...`);
        try {
            const code = await client.requestPairingCode(phoneNumber);
            console.log('\n=========================================');
            console.log(`>> WA PAIRING CODE: ${code} <<`);
            console.log('=========================================\n');
            console.log('Please enter this code in your WhatsApp linked devices to connect.');
        } catch (err) {
            console.error('Failed to request pairing code:', err);
        }
    } else {
        console.log('PHONE_NUMBER missing. Fallback to QR Code:');
        qrcode.generate(qr, { small: true });
    }
});

// 5. Bot Ready Status
client.on('ready', () => {
    console.log('Client is ready! Daina AI is now ONLINE and ready to help customers.');
});

// 6. Handle Incoming Messages
client.on('message', async (msg) => {
    // Ignore status updates and group messages
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return;

    console.log(`Message received from ${msg.from}: ${msg.body}`);

    try {
        const prompt = msg.body;
        // Generate reply using Daina's persona
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // Send AI response back to the customer
        await msg.reply(responseText);
    } catch (error) {
        console.error('AI Error:', error);
        await msg.reply('Technical issue ki wajah se main abhi reply nahi kar pa rahi. Team jald hi apse rabta karegi.');
    }
});

// Start the bot
client.initialize();
