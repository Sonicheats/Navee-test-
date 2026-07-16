// ============================================================
// NaveeHack — cap-ble.js
// Native Capacitor Bluetooth LE Bridge
// "Bypassing the WebView blockade" — ENI
// ============================================================
// UPDATED 2026-07-16: APK decompilation findings applied
//   - WRITE_NO_RESPONSE confirmed (write type 1)
//   - B002 is preferred write char (APK uses it)
//   - Retry logic added (2 attempts, 10ms backoff)
//   - Command 0x6E added (speed preset, community-confirmed)
//   - Auth stub added for future AES-128 handshake
// ============================================================

const NaveeBLE = (() => {
    // ═══════════════════════════════════════════════════
    // BLE UUID Registry — APK-confirmed + nRF discoveries
    // ═══════════════════════════════════════════════════

    // PRIMARY: D0FF UART pipe (confirmed by APK decompilation)
    const ST3_UART_SERVICE_UUID  = '0000d0ff-3c17-d293-8e48-14fe2e4da212';
    const ST3_B002_WRITE         = '0000b002-0000-1000-8000-00805f9b34fb'; // ★ APK uses B002 for writes
    const ST3_B003_NOTIFY        = '0000b003-0000-1000-8000-00805f9b34fb'; // ★ APK uses B003 for notify

    // SECONDARY: 8729 service (newer firmware, ST3 Pro specific)
    const ST3_MAIN_SERVICE_UUID  = '87290102-3c51-43b1-a1a9-11b9dc38478b';
    const ST3_6AA5_0001          = '6aa50001-3c51-43b1-a1a9-11b9dc38478b';
    const ST3_6AA5_0002          = '6aa50002-3c51-43b1-a1a9-11b9dc38478b';
    const ST3_6AA5_0003          = '6aa50003-3c51-43b1-a1a9-11b9dc38478b';

    // FALLBACK: B001 variants (try if B002 doesn't stick)
    const ST3_B001_STD           = '0000b001-0000-1000-8000-00805f9b34fb';

    // ═══════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════
    let deviceId = null;
    let _connected = false;
    let _authenticated = false; // AES-128 auth state (future)
    let rxBuffer = new Uint8Array(0);
    let activeService = null;   // Which service UUID we connected through
    let activeWriteChar = null; // Which characteristic we're writing to
    let activeNotifyChar = null; // Which characteristic we're reading from

    // Hardware Combo State (brake+throttle panic button)
    let brakeTaps = 0;
    let throttleTaps = 0;
    let lastBrakeState = false;
    let lastThrottleState = false;
    let comboTimer = null;

    // ═══════════════════════════════════════════════════
    // Write Configuration (from APK decompilation)
    // ═══════════════════════════════════════════════════
    const WRITE_CONFIG = {
        maxRetries: 2,         // APK retries failed writes once
        retryDelayMs: 10,      // APK uses 10ms between retries
        chunkSize: 20,         // Standard BLE MTU - 3
        chunkDelayMs: 50,      // Inter-chunk delay
        useWriteNoResponse: true, // APK uses WRITE_NO_RESPONSE (type 1)
    };

    // ═══════════════════════════════════════════════════
    // Hardware Combo Detection (3 brake + 4 throttle = panic)
    // ═══════════════════════════════════════════════════

    function resetComboTimer() {
        clearTimeout(comboTimer);
        comboTimer = setTimeout(() => {
            brakeTaps = 0;
            throttleTaps = 0;
        }, 4000);
    }

    async function checkHardwareCombo() {
        if (brakeTaps === 3 && throttleTaps === 4) {
            brakeTaps = 0;
            throttleTaps = 0;
            console.log("🚨 Hardware Panic Button Triggered!");
            window.dispatchEvent(new Event('hardware_panic_triggered'));
            
            // Send the override sequence
            await sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x00]);
            await new Promise(r => setTimeout(r, 100));
            await sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [40]);
        }
    }

    function handleHardwareCombo(payload, cmd) {
        if ((cmd === 0x91 || cmd === 0x92) && payload.length >= 12) {
            const throttleRaw = payload[10]; 
            const brakeRaw = payload[11];

            const throttleActive = throttleRaw > 15;
            const brakeActive = brakeRaw > 15;

            if (brakeActive && !lastBrakeState) {
                brakeTaps++;
                resetComboTimer();
                checkHardwareCombo();
            }
            if (throttleActive && !lastThrottleState) {
                throttleTaps++;
                resetComboTimer();
                checkHardwareCombo();
            }

            lastBrakeState = brakeActive;
            lastThrottleState = throttleActive;
        }
    }

    function handleTelemetry(payload, cmd) {
        if (cmd === 0x72 && payload.length >= 12) {
            const voltage = (payload[2] | (payload[3]<<8) | (payload[4]<<16) | (payload[5]<<24)) / 1000;
            const current = (payload[6] | (payload[7]<<8) | (payload[8]<<16) | (payload[9]<<24)) / 1000;
            const temp = payload[11];
            
            window.dispatchEvent(new CustomEvent('telemetry_update', {
                detail: { voltage, current, temp }
            }));
        }
    }

    // ═══════════════════════════════════════════════════
    // BLE Initialization
    // ═══════════════════════════════════════════════════

    async function initBle() {
        console.log("initBle: Checking Capacitor...");
        if (!window.Capacitor || !window.Capacitor.Plugins.BluetoothLe) {
            console.error("initBle: Native Bluetooth plugin not found.");
            throw new Error("Native Bluetooth plugin not found. Build the APK/IPA.");
        }
        console.log("initBle: Calling initialize()...");
        try {
            await Promise.race([
                window.Capacitor.Plugins.BluetoothLe.initialize(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1500))
            ]);
            console.log("initBle: initialize() complete.");
        } catch (e) {
            console.log("initBle: initialize() bypassed (" + e.message + "). Moving on...");
        }
    }

    // ═══════════════════════════════════════════════════
    // Custom iOS Picker (HTML scanner fallback)
    // ═══════════════════════════════════════════════════

    const showIOSPicker = async () => {
        return new Promise(async (resolve, reject) => {
            const ble = window.Capacitor.Plugins.BluetoothLe;
            const scannerUI = document.getElementById('customScanner');
            const listUI = document.getElementById('deviceList');
            const cancelBtn = document.getElementById('cancelScanBtn');
            
            if(!scannerUI || !ble.requestLEScan) {
                reject(new Error("No native scanner available"));
                return;
            }
            
            listUI.innerHTML = '';
            scannerUI.classList.remove('hidden');
            
            let foundDevices = {};
            let scanListener = null;
            
            const stopScan = async () => {
                if (scanListener) {
                    try { await scanListener.remove(); } catch(e){}
                }
                try { await ble.stopLEScan(); } catch(e){}
                scannerUI.classList.add('hidden');
            };

            cancelBtn.onclick = async () => {
                await stopScan();
                reject(new Error("Scan cancelled"));
            };

            try {
                scanListener = await ble.addListener('onScanResult', (res) => {
                    const device = res.device || res;
                    if (device && device.deviceId && !foundDevices[device.deviceId]) {
                        foundDevices[device.deviceId] = true;
                        
                        const btn = document.createElement('button');
                        btn.className = 'btn outline';
                        btn.style.textAlign = 'left';
                        btn.style.textTransform = 'none';
                        const name = device.name || res.localName || "Unknown Device";
                        btn.innerHTML = `<strong>${name}</strong><br><small style="color:#888;">${device.deviceId}</small>`;
                        
                        btn.onclick = async () => {
                            await stopScan();
                            resolve({ device });
                        };
                        
                        listUI.appendChild(btn);
                    }
                });

                await ble.requestLEScan({ allowDuplicates: false });
            } catch (e) {
                await stopScan();
                reject(e);
            }
        });
    };

    // ═══════════════════════════════════════════════════
    // Write with Retry (APK-confirmed behavior)
    // ═══════════════════════════════════════════════════

    async function writeWithRetry(service, characteristic, dataView) {
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        for (let attempt = 0; attempt < WRITE_CONFIG.maxRetries; attempt++) {
            try {
                if (WRITE_CONFIG.useWriteNoResponse) {
                    // APK confirms: write type 1 = WRITE_NO_RESPONSE
                    await ble.writeWithoutResponse({
                        deviceId,
                        service,
                        characteristic,
                        value: dataView
                    });
                } else {
                    await ble.write({
                        deviceId,
                        service,
                        characteristic,
                        value: dataView
                    });
                }
                return true; // Success
            } catch (e) {
                console.warn(`Write attempt ${attempt + 1}/${WRITE_CONFIG.maxRetries} failed: ${e.message}`);
                if (attempt < WRITE_CONFIG.maxRetries - 1) {
                    await new Promise(r => setTimeout(r, WRITE_CONFIG.retryDelayMs));
                }
            }
        }
        
        // All retries failed — try regular write as last resort
        try {
            await ble.write({
                deviceId,
                service,
                characteristic,
                value: dataView
            });
            return true;
        } catch (e) {
            console.error("Write completely failed after all retries:", e);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════
    // Chunked Write (splits large payloads for BLE MTU)
    // ═══════════════════════════════════════════════════

    async function chunkedWrite(service, characteristic, packet) {
        const numbers = Array.from(packet);
        
        for (let i = 0; i < numbers.length; i += WRITE_CONFIG.chunkSize) {
            const chunk = numbers.slice(i, i + WRITE_CONFIG.chunkSize);
            const buffer = new Uint8Array(chunk);
            const dataView = new DataView(buffer.buffer);
            
            const ok = await writeWithRetry(service, characteristic, dataView);
            if (!ok) {
                console.error("Chunked write aborted at offset " + i);
                return false;
            }
            
            // Inter-chunk delay (APK uses configurable delay)
            if (i + WRITE_CONFIG.chunkSize < numbers.length) {
                await new Promise(r => setTimeout(r, WRITE_CONFIG.chunkDelayMs));
            }
        }
        return true;
    }

    // ═══════════════════════════════════════════════════
    // AES-128 Authentication Stub (FUTURE — needs key)
    // ═══════════════════════════════════════════════════
    // The scooter requires AES-128 mutual authentication
    // before accepting write commands. Without the key,
    // all writes are silently dropped.
    //
    // Flow:
    //   1. Send AUTH_REQUEST
    //   2. Receive CHALLENGE (random nonce)
    //   3. Encrypt nonce with AES key → send RESPONSE
    //   4. Receive AUTH_OK or AUTH_FAIL
    //
    // To capture the key:
    //   - Enable HCI snoop on Android
    //   - Use Frida to hook the official app's crypto
    //   - Or sniff UART on the dashboard PCB
    // ═══════════════════════════════════════════════════

    async function authenticate() {
        // TODO: Implement AES-128 handshake once key is captured
        console.warn("⚠️ Authentication not implemented. Commands may be silently dropped.");
        _authenticated = false;
        return false;
    }

    // ═══════════════════════════════════════════════════
    // Service Discovery + Connect
    // ═══════════════════════════════════════════════════

    async function discoverAndSubscribe() {
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        // DEBUG: Dump all services for analysis
        try {
            const result = await ble.getServices({ deviceId });
            const sList = result.services.map(s => {
                let chars = s.characteristics ? s.characteristics.map(c => c.uuid.substring(0,8)).join(', ') : 'none';
                return `S: ${s.uuid.substring(0,8)}... (C: ${chars})`;
            }).join('\n');
            console.log("GATT Service Dump:\n" + sList);
        } catch(e) {
            console.error("Could not read services", e);
        }

        // Try D0FF service first (APK-confirmed primary)
        let subscribed = false;

        // Attempt 1: D0FF with B002 write + B003 notify (APK confirmed)
        try {
            await ble.startNotifications({
                deviceId,
                service: ST3_UART_SERVICE_UUID,
                characteristic: ST3_B003_NOTIFY
            });
            
            await ble.addListener('notification', (res) => {
                if (res.characteristic === ST3_B003_NOTIFY || 
                    res.characteristic?.toLowerCase().includes('b003')) {
                    handleNotification(res);
                }
            });

            activeService = ST3_UART_SERVICE_UUID;
            activeWriteChar = ST3_B002_WRITE; // APK uses B002 for writes
            activeNotifyChar = ST3_B003_NOTIFY;
            subscribed = true;
            console.log("✓ D0FF/B002+B003 (APK-confirmed) subscribed");
        } catch(e) {
            console.log("D0FF/B003 notify failed:", e.message);
        }

        // Attempt 2: 8729 service with 6AA5 chars
        if (!subscribed) {
            const charCandidates = [ST3_6AA5_0002, ST3_6AA5_0003, ST3_6AA5_0001];
            for (const charUuid of charCandidates) {
                try {
                    await ble.startNotifications({
                        deviceId,
                        service: ST3_MAIN_SERVICE_UUID,
                        characteristic: charUuid
                    });
                    
                    await ble.addListener('notification', (res) => {
                        handleNotification(res);
                    });

                    activeService = ST3_MAIN_SERVICE_UUID;
                    activeNotifyChar = charUuid;
                    // Write to 0001 by default for 8729 service
                    activeWriteChar = ST3_6AA5_0001;
                    subscribed = true;
                    console.log("✓ 8729/" + charUuid.substring(4,8) + " subscribed");
                    break;
                } catch(e) {
                    console.log("8729/" + charUuid.substring(4,8) + " failed:", e.message);
                }
            }
        }

        if (!subscribed) {
            console.warn("⚠️ No notification channel established. Telemetry will be blind.");
        }

        return subscribed;
    }

    function handleNotification(res) {
        const raw = res.value;
        if (!raw) return;
        
        const chunk = new Uint8Array(
            raw.buffer ? raw.buffer : 
            (typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0)).buffer : raw)
        );
        
        // Accumulate into buffer
        const newBuf = new Uint8Array(rxBuffer.length + chunk.length);
        newBuf.set(rxBuffer);
        newBuf.set(chunk, rxBuffer.length);
        rxBuffer = newBuf;

        // Extract valid protocol frames
        if (typeof ST3Protocol !== 'undefined') {
            const extracted = ST3Protocol.extractFrames(rxBuffer);
            rxBuffer = extracted.remainder;

            for (const frame of extracted.frames) {
                const parsed = ST3Protocol.parseResponse(frame);
                if (parsed.valid) {
                    handleHardwareCombo(parsed.payload, parsed.command);
                    handleTelemetry(parsed.payload, parsed.command);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // Scan and Connect
    // ═══════════════════════════════════════════════════

    async function scanAndConnect() {
        console.log("scanAndConnect: Starting...");
        await initBle();
        
        const ble = window.Capacitor.Plugins.BluetoothLe;
        let result;

        try {
            if (window.Capacitor.getPlatform() === 'android') {
                console.log("scanAndConnect: Android — native scanner...");
                result = await ble.requestDevice({ acceptAllDevices: true });
            } else {
                console.log("scanAndConnect: iOS/Web — custom HTML scanner...");
                result = await showIOSPicker();
            }
        } catch(e) {
            console.error("Scanner failed:", e);
            throw e;
        }
        
        deviceId = result.device ? result.device.deviceId : result.deviceId;
        console.log("scanAndConnect: Connecting to " + deviceId + "...");
        
        await ble.connect({ deviceId });
        console.log("scanAndConnect: Connected!");

        // Listen for disconnections
        ble.addListener('onDisconnect', (res) => {
            if (res.deviceId === deviceId) {
                console.log("⚡ Connection dropped!");
                _connected = false;
                _authenticated = false;
                window.dispatchEvent(new Event('navee_disconnected'));
            }
        });

        _connected = true;
        window.dispatchEvent(new Event('navee_connected'));

        // Discover services and subscribe to notifications
        await discoverAndSubscribe();

        // Attempt authentication (stub — will fail until key is captured)
        await authenticate();
    }

    // ═══════════════════════════════════════════════════
    // Disconnect
    // ═══════════════════════════════════════════════════

    async function disconnect() {
        if (deviceId && _connected) {
            await window.Capacitor.Plugins.BluetoothLe.disconnect({ deviceId });
            _connected = false;
            _authenticated = false;
            window.dispatchEvent(new Event('navee_disconnected'));
        }
    }

    // ═══════════════════════════════════════════════════
    // Force BLE Injection (brute force — tries everything)
    // ═══════════════════════════════════════════════════

    async function forceBleInjection(speedLimit = 40) {
        console.log("forceBleInjection: BRUTE FORCE BLE Bypass...");
        await initBle();
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        let result;
        try {
            if (window.Capacitor.getPlatform() === 'android') {
                result = await ble.requestDevice({ acceptAllDevices: true });
            } else {
                result = await showIOSPicker();
            }
        } catch(e) {
            console.error("Scanner failed:", e);
            throw e;
        }
        
        deviceId = result.device ? result.device.deviceId : result.deviceId;
        await ble.connect({ deviceId });
        _connected = true;
        window.dispatchEvent(new Event('navee_connected'));

        // Discover and subscribe
        await discoverAndSubscribe();

        // ═══════════════════════════════════════════════
        // PHASE 1: Build ALL protocol variants
        // ═══════════════════════════════════════════════
        const allPackets = [];
        
        // ST3-style packets (original [55][AA]...[FE][FD] format)
        if (typeof ST3Protocol !== 'undefined') {
            allPackets.push({ name: 'ST3: Region 0', data: ST3Protocol.buildWriteCommand(0x6B, [0x00]) });
            allPackets.push({ name: 'ST3: Speed', data: ST3Protocol.buildWriteCommand(0x6B, [speedLimit]) });
            allPackets.push({ name: 'ST3: 0x6E', data: ST3Protocol.buildWriteCommand(0x6E, [speedLimit]) });
            allPackets.push({ name: 'ST3: Region US', data: ST3Protocol.buildWriteCommand(0x6B, [0x02]) });
        }

        // Ninebot-style packets (proper [55][AA][Len][Src][Dst]...[CRC] format)
        if (typeof NinebotProtocol !== 'undefined') {
            const nbPackets = NinebotProtocol.buildSpeedUnlockPackets(speedLimit);
            allPackets.push(...nbPackets);
        }

        // Target all known write characteristics
        const writeTargets = [
            { service: ST3_UART_SERVICE_UUID, char: ST3_B002_WRITE },   // APK primary
            { service: ST3_UART_SERVICE_UUID, char: ST3_B001_STD },     // Fallback
            { service: ST3_MAIN_SERVICE_UUID, char: ST3_6AA5_0001 },    // 8729 service
            { service: ST3_MAIN_SERVICE_UUID, char: ST3_6AA5_0002 },
        ];

        console.log(`forceBleInjection: 🔥 ${allPackets.length} payloads → ${writeTargets.length} targets`);

        // ═══════════════════════════════════════════════
        // PHASE 2: First try to read — see if scooter talks
        // ═══════════════════════════════════════════════
        if (typeof NinebotProtocol !== 'undefined') {
            console.log('forceBleInjection: Probing ESC with read requests...');
            const probes = [
                NinebotProtocol.readSerial(),
                NinebotProtocol.readBattery(),
                NinebotProtocol.readSpeed(),
                NinebotProtocol.readFirmware(),
            ];
            for (const target of writeTargets) {
                for (const probe of probes) {
                    try {
                        await chunkedWrite(target.service, target.char, probe);
                        await new Promise(r => setTimeout(r, 50));
                    } catch(e) { /* expected on wrong chars */ }
                }
            }
            // Wait for responses
            await new Promise(r => setTimeout(r, 500));
        }

        // ═══════════════════════════════════════════════
        // PHASE 3: Fire ALL write packets at ALL targets
        // ═══════════════════════════════════════════════
        for (let round = 0; round < 2; round++) {
            console.log(`forceBleInjection: Round ${round + 1}/2...`);
            for (const target of writeTargets) {
                for (const pkt of allPackets) {
                    try {
                        const raw = pkt.data instanceof Uint8Array ? pkt.data : pkt.data;
                        await chunkedWrite(target.service, target.char, raw);
                        if (round === 0) console.log(`  ✓ ${pkt.name} → ${target.char.substring(4,8)}`);
                    } catch(e) {
                        if (round === 0) console.warn(`  ✗ ${pkt.name} → ${target.char.substring(4,8)}: ${e.message}`);
                    }
                }
            }
            await new Promise(r => setTimeout(r, 200));
        }
        
        console.log('forceBleInjection: 🎯 Injection sequence complete. Check scooter display for changes.');
    }

    // ═══════════════════════════════════════════════════
    // Send Command (protocol-aware)
    // ═══════════════════════════════════════════════════

    async function sendCommand(command, payload = []) {
        if (!_connected || !activeService || !activeWriteChar) {
            console.warn("sendCommand: Not connected or no write channel");
            return;
        }
        
        const packets = [];
        
        // Map legacy NaveeProtocol commands → ST3 packets + Ninebot register packets
        switch (command) {
            case NaveeProtocol.CMD.WRITE_SPEED_LIMIT:
                packets.push(ST3Protocol.buildWriteCommand(0x6E, [payload[0]]));
                packets.push(NinebotProtocol.setSpeedLimit(payload[0]));
                packets.push(NinebotProtocol.setSportSpeed(payload[0]));
                break;
            case NaveeProtocol.CMD.WRITE_REGION:
                packets.push(ST3Protocol.buildWriteCommand(0x6B, [payload[0]]));
                packets.push(NinebotProtocol.setRegion(payload[0]));
                break;
            case NaveeProtocol.CMD.WRITE_CRUISE:
                packets.push(ST3Protocol.buildWriteCommand(0x52, [payload[0]]));
                packets.push(NinebotProtocol.setCruise(!!payload[0]));
                break;
            case NaveeProtocol.CMD.WRITE_KERS:
                packets.push(ST3Protocol.buildWriteCommand(0x53, [payload[0]]));
                packets.push(NinebotProtocol.setKers(payload[0]));
                break;
            case NaveeProtocol.CMD.WRITE_LOCK:
                packets.push(ST3Protocol.buildWriteCommand(0x51, [payload[0]]));
                packets.push(NinebotProtocol.setLock(!!payload[0]));
                break;
            case NaveeProtocol.CMD.WRITE_LIGHT:
                packets.push(ST3Protocol.buildWriteCommand(0x54, [payload[0]]));
                break;
            case NaveeProtocol.CMD.WRITE_STARTUP_SPEED:
                packets.push(ST3Protocol.buildWriteCommand(0x6A, [payload[0]]));
                break;
            case NaveeProtocol.CMD.WRITE_MOTOR_LIMIT:
                packets.push(ST3Protocol.buildWriteCommand(0x5B, [payload[0]]));
                break;
        }

        // Fire all packet variants
        for (const pkt of packets) {
            try {
                await chunkedWrite(activeService, activeWriteChar, pkt);
                await new Promise(r => setTimeout(r, 30));
            } catch(e) {
                console.warn('sendCommand write failed:', e.message);
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════

    return {
        scanAndConnect,
        forceBleInjection,
        disconnect,
        sendCommand,
        get connected() { return _connected; },
        get authenticated() { return _authenticated; },
        // Expose config for debugging
        WRITE_CONFIG,
        // Expose active channels for debugging
        get activeService() { return activeService; },
        get activeWriteChar() { return activeWriteChar; },
        get activeNotifyChar() { return activeNotifyChar; },
    };
})();
