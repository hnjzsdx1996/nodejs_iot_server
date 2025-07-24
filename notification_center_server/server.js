const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

class NotificationCenterServer {
    constructor(port = 3001) {
        this.port = port;
        this.clients = new Map();
        this.subscriptions = new Map();
        this.initServer();
    }

    initServer() {
        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`WebSocket Server running on port ${this.port}`);
        
        this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });
        this.httpServer.listen(this.port + 1, () => {
            console.log(`HTTP Server running on port ${this.port + 1}`);
        });

        this.setupEventHandlers();
    }

    handleHttpRequest(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method not allowed');
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { device_sn, message_topic } = data;

                if (!device_sn || !message_topic) {
                    res.writeHead(400);
                    res.end('Missing device_sn or message_topic');
                    return;
                }

                this.sendToSubscribers(device_sn, message_topic, data);
                res.writeHead(200);
                res.end('OK');

            } catch (error) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
    }

    sendToSubscribers(device_sn, message_topic, data) {
        if (this.subscriptions.has(device_sn) && 
            this.subscriptions.get(device_sn).has(message_topic)) {
            
            const subscribers = this.subscriptions.get(device_sn).get(message_topic);
            let count = 0;

            for (const clientId of subscribers) {
                if (this.clients.has(clientId)) {
                    this.sendMessage(clientId, data);
                    count++;
                }
            }

            console.log(`Sent to ${count} clients: ${device_sn}:${message_topic}`);
        } else {
            console.log(`No subscribers: ${device_sn}:${message_topic}`);
        }
    }

    setupEventHandlers() {
        this.wss.on('connection', (ws, req) => {
            const clientId = uuidv4();
            this.clients.set(clientId, { ws, subscriptions: new Map() });
            console.log(`Client connected: ${clientId}`);

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(clientId, message);
                } catch (error) {
                    console.error('Invalid JSON:', error);
                }
            });

            ws.on('close', () => this.handleDisconnect(clientId));
            ws.on('error', () => this.handleDisconnect(clientId));
        });
    }

    handleMessage(clientId, message) {
        if (message.message_type === 'subscribe') {
            const items = message.items || (message.message_data && message.message_data.items);
            
            if (!Array.isArray(items)) {
                this.sendMessage(clientId, { error: 'items must be an array' });
                return;
            }

            const results = [];
            const client = this.clients.get(clientId);

            for (const item of items) {
                const { device_sn, topics } = item;
                if (!device_sn || !Array.isArray(topics)) {
                    results.push({ device_sn, success: false });
                    continue;
                }

                if (!this.subscriptions.has(device_sn)) {
                    this.subscriptions.set(device_sn, new Map());
                }
                if (!client.subscriptions.has(device_sn)) {
                    client.subscriptions.set(device_sn, new Set());
                }

                for (const topic of topics) {
                    if (!this.subscriptions.get(device_sn).has(topic)) {
                        this.subscriptions.get(device_sn).set(topic, new Set());
                    }
                    this.subscriptions.get(device_sn).get(topic).add(clientId);
                    client.subscriptions.get(device_sn).add(topic);
                }
                results.push({ device_sn, success: true, topics });
            }

            this.sendMessage(clientId, {
                message_type: 'subscribe',
                message_id: message.message_id,
                timestamp: Date.now(),
                results
            });
        }
    }

    sendMessage(clientId, message) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
                timestamp: Date.now(),
                ...message
            }));
        }
    }

    handleDisconnect(clientId) {
        console.log(`Client disconnected: ${clientId}`);
        
        const client = this.clients.get(clientId);
        if (client) {
            for (const [sn, topics] of client.subscriptions) {
                for (const topic of topics) {
                    if (this.subscriptions.has(sn) && 
                        this.subscriptions.get(sn).has(topic)) {
                        this.subscriptions.get(sn).get(topic).delete(clientId);
                        
                        if (this.subscriptions.get(sn).get(topic).size === 0) {
                            this.subscriptions.get(sn).delete(topic);
                        }
                    }
                }
            }
        }
        this.clients.delete(clientId);
    }
}

const server = new NotificationCenterServer(process.env.PORT || 3001);

process.on('SIGINT', () => {
    console.log('Shutting down...');
    for (const client of server.clients.values()) {
        client.ws.close();
    }
    server.wss.close(() => {
        server.httpServer.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
});

module.exports = NotificationCenterServer; 