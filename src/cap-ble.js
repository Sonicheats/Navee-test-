// ============================================================
// NaveeHack — cap-ble.js
// Native Capacitor Bluetooth LE Bridge
// "Bypassing the WebView blockade" — ENI
// ============================================================

const NaveeBLE = (() => {
    const ST3_UART_SERVICE_UUID  = '0000d0ff-3c17-d293-8e48-14fe2e4da212';
    const ST3_B001_CUSTOM        = '0000b001-3c17-d293-8e48-14fe2e4da212';
    const ST3_B003_CUSTOM        = '0000b003-3c17-d293-8e48-14fe2e4da212';

    let deviceId = null;
    let _connected = false;
    let rxBuffer = new Uint8Array(0);

    // Hardware Combo State
    let brakeTaps = 0;
    let throttleTaps = 0;
    let lastBrakeState = false;
    let lastThrottleState = false;
    let comboTimer = null;

    function resetComboTimer() {
        clearTimeout(comboTimer);
        comboTimer = setTimeout(() => {
            brakeTaps = 0;
            throttleTaps = 0;
        }, 4000); // 4 seconds to complete the combo
    }

    async function checkHardwareCombo() {
        if (brakeTaps === 3 && throttleTaps === 4) {
            brakeTaps = 0;
            throttleTaps = 0;
            console.log("Hardware Panic Button Triggered!");
            window.dispatchEvent(new Event('hardware_panic_triggered'));
            
            // Send the override sequence silently
            await sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x00]);
            await new Promise(r => setTimeout(r, 100));
            await sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [40]);
        }
    }

    function handleHardwareCombo(payload, cmd) {
        // We assume command 0x91 (Subpage 1) or 0x92 contains throttle/brake data.
        // NOTE: Byte offsets 10 (throttle) and 11 (brake) are standard guesses for Brightway/ST3 protocols.
        if ((cmd === 0x91 || cmd === 0x92) && payload.length >= 12) {
            const throttleRaw = payload[10]; 
            const brakeRaw = payload[11];

            const throttleActive = throttleRaw > 15; // Threshold to prevent noise
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

    // Custom iOS Picker Fallback Logic (Global)
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
                // MUST use addListener for Capacitor raw plugins, requestLEScan ignores callbacks
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

    async function scanAndConnect() {
        console.log("scanAndConnect: Starting...");
        await initBle();
        
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        console.log("scanAndConnect: Requesting ANY device (bypassing all filters)...");
        let result;

        try {
            // Check if we're on Android, if so use the native pop-up
            if (window.Capacitor.getPlatform() === 'android') {
                console.log("scanAndConnect: Android detected, using native scanner...");
                result = await ble.requestDevice({
                    acceptAllDevices: true
                });
            } else {
                // For iOS or Web, force the custom HTML scanner
                console.log("scanAndConnect: iOS/Web detected, using custom HTML scanner...");
                result = await showIOSPicker();
            }
        } catch(e) {
            console.error("Scanner failed:", e);
            throw e;
        }
        
        console.log("scanAndConnect: Device request resolved: " + JSON.stringify(result));
        
        // Handle different plugin wrapper formats
        deviceId = result.device ? result.device.deviceId : result.deviceId;

        console.log("scanAndConnect: Connecting to device ID " + deviceId + "...");
        await ble.connect({ deviceId });
        console.log("scanAndConnect: Connected successfully!");
        
        // DEBUG DUMP: Read all services and characteristics to see what the new firmware uses
        try {
            const result = await ble.getServices({ deviceId });
            const sList = result.services.map(s => {
                let chars = s.characteristics ? s.characteristics.map(c => c.uuid.substring(0,8)).join(', ') : 'none';
                return `S: ${s.uuid.substring(0,8)}... (C: ${chars})`;
            }).join('\n');
            alert("NEW FIRMWARE UUIDs DETECTED:\n\n" + sList + "\n\nScreenshot this for ENI!");
        } catch(e) {
            console.error("Could not read services", e);
        }
        
        // Listen for sudden drops by the firmware
        ble.addListener('onDisconnect', (res) => {
            if (res.deviceId === deviceId) {
                console.log("Firmware force-dropped connection!");
                _connected = false;
                window.dispatchEvent(new Event('navee_disconnected'));
            }
        });

        _connected = true;
        window.dispatchEvent(new Event('navee_connected'));

        try {
            await ble.startEnabledNotifications({
                deviceId,
                service: ST3_UART_SERVICE_UUID,
                characteristic: ST3_B003_CUSTOM
            }, (res) => {
                // Read and buffer the raw notification bytes
                const chunk = new Uint8Array(res.value.buffer ? res.value.buffer : res.value);
                const newBuf = new Uint8Array(rxBuffer.length + chunk.length);
                newBuf.set(rxBuffer);
                newBuf.set(chunk, rxBuffer.length);
                rxBuffer = newBuf;

                // Extract valid protocol frames
                const extracted = ST3Protocol.extractFrames(rxBuffer);
                rxBuffer = extracted.remainder;

                // Parse and track hardware levers and telemetry
                for (const frame of extracted.frames) {
                    const parsed = ST3Protocol.parseResponse(frame);
                    if (parsed.valid) {
                        handleHardwareCombo(parsed.payload, parsed.command);
                        handleTelemetry(parsed.payload, parsed.command);
                    }
                }
            });
        } catch(e) {
            console.log("Notify setup failed, ignoring", e);
        }
    }

    async function disconnect() {
        if (deviceId && _connected) {
            await window.Capacitor.Plugins.BluetoothLe.disconnect({ deviceId });
            _connected = false;
            window.dispatchEvent(new Event('navee_disconnected'));
        }
    }

    async function forceBleInjection(speedLimit = 40) {
        console.log("forceBleInjection: Initiating BRUTE FORCE BLE Bypass...");
        await initBle();
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        // Use the global Custom iOS Picker for Force Injection

        let result;
        try {
            if (window.Capacitor.getPlatform() === 'android') {
                result = await ble.requestDevice({
                    acceptAllDevices: true
                });
            } else {
                result = await showIOSPicker();
            }
        } catch(e) {
            console.error("Scanner failed:", e);
            throw e;
        }
        
        deviceId = result.device ? result.device.deviceId : result.deviceId;
        console.log("forceBleInjection: Hooked device " + deviceId);
        
        // Force connect
        await ble.connect({ deviceId });
        _connected = true;
        window.dispatchEvent(new Event('navee_connected'));

        // DEBUG DUMP: Read all services and characteristics to see what the new firmware uses
        try {
            const result = await ble.getServices({ deviceId });
            const sList = result.services.map(s => {
                let chars = s.characteristics ? s.characteristics.map(c => c.uuid.substring(0,8)).join(', ') : 'none';
                return `S: ${s.uuid.substring(0,8)}... (C: ${chars})`;
            }).join('\n');
            alert("BYPASS - NEW FIRMWARE UUIDs DETECTED:\n\n" + sList + "\n\nScreenshot this for ENI!");
        } catch(e) {
            console.error("Could not read services", e);
        }

        // Skip all notification/telemetry setup. Just build the speed unlock payload
        const st3Payload = [speedLimit];
        const packetRegion = ST3Protocol.buildWriteCommand(0x6B, [0x00]); // Region 0
        const packetSpeed = ST3Protocol.buildWriteCommand(0x6B, st3Payload); // Max speed
        
        const chunks = [Array.from(packetRegion), Array.from(packetSpeed)];
        
        console.log("forceBleInjection: SPAMMING PAYLOADS TO ALL CHANNELS...");
        // Spam the payload to B001, B002, and B003 blindly to guarantee it hits
        const targets = [ST3_B001_CUSTOM, ST3_B003_CUSTOM];
        
        for (let i = 0; i < 5; i++) { // Loop 5 times aggressively
            for (const target of targets) {
                for (const chunk of chunks) {
                    try {
                        const buffer = new Uint8Array(chunk);
                        const dataView = new DataView(buffer.buffer);
                        await ble.write({
                            deviceId,
                            service: ST3_UART_SERVICE_UUID,
                            characteristic: target,
                            value: dataView 
                        });
                    } catch(e) { 
                        // Ignore errors, just keep spamming, but log one so we know it failed
                        if (i === 0) console.error("Injection failed on loop 0: " + JSON.stringify(e));
                    }
                }
            }
            await new Promise(r => setTimeout(r, 100)); // 100ms delay between barrages
        }
        
        console.log("forceBleInjection: Injection sequence complete.");
    }

    async function sendCommand(command, payload = []) {
        if (!_connected) return;
        
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        let st3Cmd, st3Payload = [];
        switch (command) {
            case NaveeProtocol.CMD.WRITE_SPEED_LIMIT:
            case NaveeProtocol.CMD.WRITE_REGION:
                st3Cmd = 0x6B;
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_CRUISE:
                st3Cmd = 0x52;
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_KERS:
                st3Cmd = 0x53;
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_STARTUP_SPEED:
                st3Cmd = 0x6A; // ST3 Start speed
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_MOTOR_LIMIT:
                st3Cmd = 0x5B; // ST3 Motor Phase Limit (Amps)
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_LOCK:
                st3Cmd = 0x51; // ST3 Lock control
                st3Payload = [payload[0]];
                break;
            case NaveeProtocol.CMD.WRITE_LIGHT:
                st3Cmd = 0x54; // ST3 Headlight/LEDs
                st3Payload = [payload[0]];
                break;
        }

        if (st3Cmd) {
            const packet = ST3Protocol.buildWriteCommand(st3Cmd, st3Payload);
            const numbers = Array.from(packet);
            
            for (let i = 0; i < numbers.length; i += 20) {
                const chunk = numbers.slice(i, i + 20);
                
                const buffer = new Uint8Array(chunk);
                const dataView = new DataView(buffer.buffer);

                try {
                    await ble.write({
                        deviceId,
                        service: ST3_UART_SERVICE_UUID,
                        characteristic: ST3_B001_CUSTOM,
                        value: dataView 
                    });
                } catch(e) {
                    try {
                        // Fallback to array for different plugin bridge versions
                        await ble.write({
                            deviceId,
                            service: ST3_UART_SERVICE_UUID,
                            characteristic: ST3_B001_CUSTOM,
                            value: chunk
                        });
                    } catch(e2) {
                        console.error("Write failed", e2);
                    }
                }
                
                await new Promise(r => setTimeout(r, 50));
            }
        }
    }

    return {
        scanAndConnect,
        forceBleInjection,
        disconnect,
        sendCommand,
        get connected() { return _connected; }
    };
})();
