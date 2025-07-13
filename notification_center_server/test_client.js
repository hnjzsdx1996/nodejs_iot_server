const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

class TestClient {
    constructor(url = 'ws://localhost:3001') {
        this.url = url;
        this.ws = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.on('open', () => {
                console.log('✅ Connected to server');
                this.setupEventHandlers();
                resolve();
            });

            this.ws.on('error', (error) => {
                console.error('❌ Connection error:', error);
                reject(error);
            });

            this.ws.on('close', () => {
                console.log('🔌 Disconnected from server');
            });
        });
    }

    setupEventHandlers() {
        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (error) {
                console.error('❌ Invalid message received:', error);
            }
        });
    }

    handleMessage(message) {
        const { timestamp, topic, data, uuid } = message;
        
        console.log(`📨 Received [${topic}]:`, {
            topic: topic,
            timestamp: new Date(timestamp).toLocaleTimeString(),
            data,
            uuid
        });

        // 处理心跳
        if (topic === 'heart_beat') {
            console.log('💓 Heartbeat received:', new Date(data).toLocaleTimeString());
        }

        // 处理订阅响应
        if (topic === 'subscribe_response') {
            console.log('✅ Subscribe response:', data);
        }

        // 处理取消订阅响应
        if (topic === 'unsubscribe_response') {
            console.log('❌ Unsubscribe response:', data);
        }

        // 处理错误
        if (topic === 'error') {
            console.error('❌ Error received:', data);
        }

        // 处理主题数据推送
        if (topic === 'topic1' || topic === 'topic2') {
            console.log(`📡 Topic data [${topic}]:`, data);
        }
    }

    sendMessage(topic, data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('❌ WebSocket is not connected');
            return;
        }

        const message = {
            timestamp: Date.now(),
            topic,
            data,
            uuid: uuidv4()
        };

        console.log(`📤 Sending [${topic}]:`, message);
        this.ws.send(JSON.stringify(message));
    }

    subscribe(sn, topicList) {
        this.sendMessage('subscribe', [{
            sn,
            topic_list: topicList
        }]);
    }

    unsubscribe(sn, topicList) {
        this.sendMessage('unsubscribe', [{
            sn,
            topic_list: topicList
        }]);
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

// 演示脚本
async function runDemo() {
    const client = new TestClient();
    
    try {
        // 连接到服务器
        await client.connect();
        
        // 等待2秒后开始测试
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('\n🚀 Starting demo...\n');
        
        // 订阅 topic1 和 topic2
        console.log('📋 Subscribing to topic1 and topic2...');
        // client.subscribe('drone_001', ['topic1', 'topic2']);
        client.subscribe('drone_001', ['topic1']);
        
        // 等待10秒观察数据推送
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // 取消订阅 topic1
        console.log('\n📋 Unsubscribing from topic1...');
        client.unsubscribe('drone_001', ['topic1']);
        
        // // 等待5秒观察只有 topic2 的数据推送
        // await new Promise(resolve => setTimeout(resolve, 5000));
        
        // // 取消订阅 topic2
        // console.log('\n📋 Unsubscribing from topic2...');
        // client.unsubscribe('drone_001', ['topic2']);
        
        // 等待3秒后断开连接
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('\n🔌 Disconnecting...');
        client.disconnect();
        
    } catch (error) {
        console.error('❌ Demo failed:', error);
        client.disconnect();
    }
}

// 如果直接运行此文件，启动演示
if (require.main === module) {
    runDemo();
}

module.exports = TestClient; 