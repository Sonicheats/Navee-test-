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
                // We keep notifications alive to maintain the connection pipe
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
