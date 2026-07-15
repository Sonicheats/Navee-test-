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
        if (!window.Capacitor || !window.Capacitor.Plugins.BluetoothLe) {
            throw new Error("Native Bluetooth plugin not found. Build the APK/IPA.");
        }
        await window.Capacitor.Plugins.BluetoothLe.initialize();
    }

    async function scanAndConnect() {
        await initBle();
        
        const ble = window.Capacitor.Plugins.BluetoothLe;
        
        const result = await ble.requestDevice({
            acceptAllDevices: true,
            optionalServices: [ST3_UART_SERVICE_UUID]
        });
        
        // Handle different plugin wrapper formats
        deviceId = result.device ? result.device.deviceId : result.deviceId;

        await ble.connect({ deviceId });
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
        disconnect,
        sendCommand,
        get connected() { return _connected; }
    };
})();
