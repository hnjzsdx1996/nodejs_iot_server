const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const fs = require('fs');

class NotificationCenterServer {
    constructor(port = 8080, useSSL = false) {
        this.port = port;
        this.useSSL = useSSL;
        this.clients = new Map(); // 存储客户端连接
        this.subscriptions = new Map(); // 存储订阅关系: {sn: {topic: Set<clientId>}}
        this.heartbeatIntervals = new Map(); // 存储心跳定时器
        this.topicDataIntervals = new Map(); // 存储主题数据推送定时器
        
        this.initServer();
    }

    initServer() {
        if (this.useSSL) {
            // 使用 WSS 协议
            const options = {
                key: fs.readFileSync('./ssl/private.key'),
                cert: fs.readFileSync('./ssl/certificate.crt')
            };
            const httpsServer = https.createServer(options);
            this.wss = new WebSocket.Server({ server: httpsServer });
            httpsServer.listen(this.port, () => {
                console.log(`WSS Server running on port ${this.port}`);
            });
        } else {
            // 使用 WS 协议
            this.wss = new WebSocket.Server({ port: this.port });
            console.log(`WS Server running on port ${this.port}`);
        }

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.wss.on('connection', (ws, req) => {
            const clientId = uuidv4();
            const clientInfo = {
                ws,
                id: clientId,
                ip: req.socket.remoteAddress,
                connectedAt: new Date(),
                subscriptions: new Map() // {sn: Set<topic>}
            };

            this.clients.set(clientId, clientInfo);
            console.log(`Client connected: ${clientId} from ${clientInfo.ip}`);

            // 开始发送心跳
            // 方便调试，先不发送心跳了
            // this.startHeartbeat(clientId);

            // 设置消息处理器
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(clientId, message);
                } catch (error) {
                    console.error('Invalid JSON message:', error);
                    this.sendError(clientId, 'Invalid JSON format');
                }
            });

            // 设置连接关闭处理器
            ws.on('close', () => {
                this.handleClientDisconnect(clientId);
            });

            // 设置错误处理器
            ws.on('error', (error) => {
                console.error(`Client ${clientId} error:`, error);
                this.handleClientDisconnect(clientId);
            });
        });
    }

    handleMessage(clientId, message) {
        const { topic, data, uuid: messageUuid, message_type, timestamp, message_id, version, notify_strategy, items } = message;

        // 处理pong消息
        if (message_type === 'pong') {
            const now = Date.now();
            const rtt = now - timestamp;
            console.log(`收到客户端PONG, 时间戳: ${timestamp}, RTT: ${rtt} ms`);
            return;
        }

        // 处理新的订阅格式
        if (message_type === 'subscribe') {
            try {
                // 从 message_data 中获取 items，如果没有则从根级别获取
                let itemsArray = items;
                if (!Array.isArray(itemsArray) && message.message_data && Array.isArray(message.message_data.items)) {
                    itemsArray = message.message_data.items;
                }
                
                if (!Array.isArray(itemsArray)) {
                    throw new Error('items must be an array');
                }
                const results = [];
                const client = this.clients.get(clientId);
                for (const item of itemsArray) {
                    const { device_sn, topics } = item;
                    if (!device_sn || !Array.isArray(topics)) {
                        results.push({ device_sn, success: false, error: 'Invalid device_sn or topics' });
                        continue;
                    }
                    // 初始化订阅关系
                    if (!this.subscriptions.has(device_sn)) {
                        this.subscriptions.set(device_sn, new Map());
                    }
                    if (!client.subscriptions.has(device_sn)) {
                        client.subscriptions.set(device_sn, new Set());
                    }
                    // 添加订阅
                    for (const topic of topics) {
                        if (!this.subscriptions.get(device_sn).has(topic)) {
                            this.subscriptions.get(device_sn).set(topic, new Set());
                        }
                        this.subscriptions.get(device_sn).get(topic).add(clientId);
                        client.subscriptions.get(device_sn).add(topic);
                    }
                    // 开始推送该主题的数据
                    this.startTopicDataPush(device_sn, topics);
                    results.push({ device_sn, success: true, topics });
                }
                // 发送订阅成功响应
                this.sendMessage(clientId, {
                    message_type: 'subscribe',
                    message_id,
                    timestamp: Date.now(),
                    version: version || '1',
                    results
                });
            } catch (error) {
                console.error('Subscribe error:', error);
                this.sendMessage(clientId, {
                    message_type: 'subscribe',
                    message_id,
                    timestamp: Date.now(),
                    version: version || '1',
                    results: [{ success: false, error: error.message }]
                });
            }
            return;
        }

        // 处理取消订阅
        if (message_type === 'unsubscribe') {
            try {
                let unsubData = data;
                if (!Array.isArray(unsubData) && message.items) {
                    unsubData = message.items.map(item => ({ sn: item.device_sn, topic_list: item.topics }));
                }
                if (!Array.isArray(unsubData)) {
                    throw new Error('取消订阅数据格式错误');
                }
                const results = [];
                const client = this.clients.get(clientId);
                for (const item of unsubData) {
                    const { sn, topic_list } = item;
                    if (!sn || !Array.isArray(topic_list)) {
                        results.push({ sn, success: false, error: 'Invalid sn or topic_list' });
                        continue;
                    }
                    // 移除订阅
                    for (const topic of topic_list) {
                        if (this.subscriptions.has(sn) && this.subscriptions.get(sn).has(topic)) {
                            this.subscriptions.get(sn).get(topic).delete(clientId);
                            // 如果没有客户端订阅该主题，删除主题并停止推送
                            if (this.subscriptions.get(sn).get(topic).size === 0) {
                                this.subscriptions.get(sn).delete(topic);
                                // 停止推送
                                const key = `${sn}_${topic}`;
                                if (this.topicDataIntervals.has(key)) {
                                    clearInterval(this.topicDataIntervals.get(key));
                                    this.topicDataIntervals.delete(key);
                                }
                            }
                        }
                        if (client.subscriptions.has(sn)) {
                            client.subscriptions.get(sn).delete(topic);
                        }
                    }
                    // 如果该sn没有订阅了，清理订阅记录
                    if (client.subscriptions.has(sn) && client.subscriptions.get(sn).size === 0) {
                        client.subscriptions.delete(sn);
                    }
                    results.push({ sn, success: true, topics: topic_list });
                }
                // 回复取消订阅结果
                this.sendMessage(clientId, {
                    message_type: 'unsubscribe',
                    message_id: message_id || '',
                    message_data: JSON.stringify(results),
                    timestamp: Date.now(),
                    need_replay: false,
                    version: version || '1'
                });
            } catch (error) {
                this.sendMessage(clientId, {
                    message_type: 'unsubscribe',
                    message_id: message_id || '',
                    message_data: JSON.stringify([{ success: false, error: error.message }]),
                    timestamp: Date.now(),
                    need_replay: false,
                    version: version || '1'
                });
            }
            return;
        }
    }

    startHeartbeat(clientId) {
        const interval = setInterval(() => {
            if (this.clients.has(clientId)) {
                this.sendMessage(clientId, {
                    message_type: 'ping',
                    message_id: uuidv4(),
                    timestamp: Date.now(),
                    need_replay: true,
                    version: '1'
                });
            } else {
                clearInterval(interval);
            }
        }, 5000); // 每5秒发送一次心跳

        this.heartbeatIntervals.set(clientId, interval);
    }

    // 修改推送数据结构
    startTopicDataPush(sn, topics) {
        for (const topic of topics) {
            const key = `${sn}_${topic}`;
            // 如果已经在推送，跳过
            if (this.topicDataIntervals.has(key)) {
                continue;
            }
            const interval = setInterval(() => {
                // 获取订阅该主题的所有客户端
                if (this.subscriptions.has(sn) && this.subscriptions.get(sn).has(topic)) {
                    const subscribers = this.subscriptions.get(sn).get(topic);
                    for (const clientId of subscribers) {
                        if (this.clients.has(clientId)) {
                            let messageData;
                            if (topic === 'aircraft_location') {
                                messageData = { 
                                    height: 1.1,      // 椭球高度
                                    elevation: 2.2,   // 相对起飞点高度
                                    longitude: 3.3,   // 经度
                                    latitude: 4.4     // 纬度
                                };
                            } else if (topic === 'aircraft_speed') {
                                messageData = { 
                                    horizontal_speed: 12.3,
                                    vertical_speed: 45.6,
                                };
                            } else if (topic === 'aircraft_attitude') {
                                messageData = { 
                                    attitude_head: 12.3,
                                    attitude_pitch: 45.6,
                                    attitude_roll: 45.6,
                                };
                            } else if (topic === 'device_osd') {
                                messageData = {
                                    "host": {
                                        "81-0-0": {
                                            "gimbal_pitch": 0,
                                            "gimbal_roll": 0,
                                            "gimbal_yaw": 121.08843265722754,
                                            "payload_index": "81-0-0",
                                            "thermal_current_palette_style": 0,
                                            "thermal_gain_mode": 2,
                                            "thermal_global_temperature_max": 19.100000381469727,
                                            "thermal_global_temperature_min": 5.300000190734863,
                                            "thermal_isotherm_lower_limit": -20,
                                            "thermal_isotherm_state": 0,
                                            "thermal_isotherm_upper_limit": 150,
                                            "zoom_factor": 0.5678233438485805
                                        },
                                        "activation_time": 0,
                                        "attitude_head": 121,
                                        "attitude_pitch": -4.3,
                                        "attitude_roll": 0.9,
                                        "battery": {
                                            "batteries": [
                                                {
                                                    "capacity_percent": 81,
                                                    "firmware_version": "26.03.08.49",
                                                    "high_voltage_storage_days": 3,
                                                    "index": 0,
                                                    "loop_times": 520,
                                                    "sn": "6Q7PL89DAP00H5",
                                                    "sub_type": 0,
                                                    "temperature": 41.9,
                                                    "type": 0,
                                                    "voltage": 15775
                                                }
                                            ],
                                            "capacity_percent": 81,
                                            "landing_power": 8,
                                            "remain_flight_time": 1986,
                                            "return_home_power": 25
                                        },
                                        "best_link_gateway": "6QCDL810020011",
                                        "cameras": [
                                            {
                                                "camera_mode": 2,
                                                "ir_metering_mode": 0,
                                                "ir_metering_point": {
                                                    "temperature": 0,
                                                    "x": 0.5,
                                                    "y": 0.5
                                                },
                                                "ir_zoom_factor": 2,
                                                "liveview_world_region": {
                                                    "bottom": 0.552438497543335,
                                                    "left": 0.4323032796382904,
                                                    "right": 0.5633704662322998,
                                                    "top": 0.4231345057487488
                                                },
                                                "payload_index": "81-0-0",
                                                "photo_state": 0,
                                                "photo_storage_settings": ["vision"],
                                                "record_time": 0,
                                                "recording_state": 0,
                                                "remain_photo_num": 9113,
                                                "remain_record_duration": 0,
                                                "screen_split_enable": false,
                                                "wide_calibrate_farthest_focus_value": 36,
                                                "wide_calibrate_nearest_focus_value": 66,
                                                "wide_exposure_mode": 1,
                                                "wide_exposure_value": 16,
                                                "wide_focus_mode": 0,
                                                "wide_focus_state": 0,
                                                "wide_focus_value": 36,
                                                "wide_iso": 3,
                                                "wide_max_focus_value": 66,
                                                "wide_min_focus_value": 35,
                                                "wide_shutter_speed": 3,
                                                "zoom_calibrate_farthest_focus_value": 36,
                                                "zoom_calibrate_nearest_focus_value": 66,
                                                "zoom_exposure_mode": 1,
                                                "zoom_exposure_value": 16,
                                                "zoom_factor": 6.999994214380596,
                                                "zoom_focus_mode": 0,
                                                "zoom_focus_state": 0,
                                                "zoom_focus_value": 36,
                                                "zoom_iso": 3,
                                                "zoom_max_focus_value": 66,
                                                "zoom_min_focus_value": 35,
                                                "zoom_shutter_speed": 3
                                            }
                                        ],
                                        "country": "CN",
                                        "distance_limit_status": {
                                            "distance_limit": 300,
                                            "is_near_distance_limit": 0,
                                            "state": 1
                                        },
                                        "elevation": 78.9,
                                        "gear": 1,
                                        "height": 128.22119750976563,
                                        "height_limit": 80,
                                        "home_distance": 0.08395953476428986,
                                        "horizontal_speed": 0,
                                        "is_near_area_limit": 1,
                                        "is_near_height_limit": 1,
                                        "latitude": 22.793217667699324,
                                        "longitude": 114.35788532514945,
                                        "maintain_status": {
                                            "maintain_status_array": [
                                                {
                                                    "last_maintain_flight_sorties": 0,
                                                    "last_maintain_flight_time": 0,
                                                    "last_maintain_time": 0,
                                                    "last_maintain_type": 1,
                                                    "state": 0
                                                },
                                                {
                                                    "last_maintain_flight_sorties": 0,
                                                    "last_maintain_flight_time": 0,
                                                    "last_maintain_time": 0,
                                                    "last_maintain_type": 2,
                                                    "state": 0
                                                },
                                                {
                                                    "last_maintain_flight_sorties": 0,
                                                    "last_maintain_flight_time": 0,
                                                    "last_maintain_time": 0,
                                                    "last_maintain_type": 3,
                                                    "state": 0
                                                }
                                            ]
                                        },
                                        "mode_code": 3,
                                        "night_lights_state": 0,
                                        "obstacle_avoidance": {
                                            "downside": 1,
                                            "horizon": 1,
                                            "upside": 1
                                        },
                                        "position_state": {
                                            "gps_number": 32,
                                            "is_fixed": 2,
                                            "quality": 5,
                                            "rtk_number": 48
                                        },
                                        "rc_lost_action": 2,
                                        "rid_state": true,
                                        "rth_altitude": 300,
                                        "storage": {
                                            "total": 60068000,
                                            "used": 3161000
                                        },
                                        "total_flight_distance": 5213978.459460843,
                                        "total_flight_sorties": 1099,
                                        "total_flight_time": 612889.8263008446,
                                        "track_id": "1e6cbb25-52b6-4de5-8db8-6f82af559d77",
                                        "vertical_speed": 0,
                                        "wind_direction": 4,
                                        "wind_speed": 54
                                    },
                                    "sn": "1581F6Q8D242100CPKTJ"
                                };
                            } else {
                                messageData = { example: topic };
                            }
                            this.sendMessage(clientId, {
                                message_type: 'publish',
                                message_id: uuidv4(),
                                device_sn: sn,
                                message_topic: topic,
                                message_data: JSON.stringify(messageData),
                                timestamp: Date.now(),
                                need_replay: false,
                                version: '1'
                            });
                        }
                    }
                } else {
                    // 没有订阅者了，停止推送
                    clearInterval(interval);
                    this.topicDataIntervals.delete(key);
                }
            }, 2000); // 每2秒推送一次
            this.topicDataIntervals.set(key, interval);
        }
    }

    sendMessage(clientId, message) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            const fullMessage = {
                timestamp: Date.now(),
                ...message
            };
            client.ws.send(JSON.stringify(fullMessage));
        }
    }

    sendError(clientId, error, messageUuid = null) {
        this.sendMessage(clientId, {
            topic: 'error',
            data: { error },
            uuid: messageUuid
        });
    }

    handleClientDisconnect(clientId) {
        console.log(`Client disconnected: ${clientId}`);
        
        // 清理心跳定时器
        if (this.heartbeatIntervals.has(clientId)) {
            clearInterval(this.heartbeatIntervals.get(clientId));
            this.heartbeatIntervals.delete(clientId);
        }

        // 清理客户端订阅
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

        // 移除客户端
        this.clients.delete(clientId);
    }

    getStats() {
        return {
            connectedClients: this.clients.size,
            subscriptions: Object.fromEntries(
                Array.from(this.subscriptions.entries()).map(([sn, topics]) => [
                    sn, 
                    Object.fromEntries(
                        Array.from(topics.entries()).map(([topic, clients]) => [
                            topic, 
                            clients.size
                        ])
                    )
                ])
            ),
            activeIntervals: {
                heartbeat: this.heartbeatIntervals.size,
                topicData: this.topicDataIntervals.size
            }
        };
    }
}

// 启动服务器
const PORT = process.env.PORT || 3001;
const USE_SSL = process.env.USE_SSL === 'false';

const server = new NotificationCenterServer(PORT, USE_SSL);

// 定期打印服务器状态
setInterval(() => {
    const stats = server.getStats();
    console.log('Server Stats:', JSON.stringify(stats, null, 2));
}, 10000); // 每10秒打印一次状态

// 优雅关闭
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    // 清理所有定时器
    for (const interval of server.heartbeatIntervals.values()) {
        clearInterval(interval);
    }
    for (const interval of server.topicDataIntervals.values()) {
        clearInterval(interval);
    }
    
    // 关闭所有客户端连接
    for (const client of server.clients.values()) {
        client.ws.close();
    }
    
    server.wss.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = NotificationCenterServer; 