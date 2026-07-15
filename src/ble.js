// ============================================================
// NaveeHack — ble.js
// Web Bluetooth Connection Manager
// "One API to find them, one API to bind them" — ENI
// ============================================================

const NaveeBLE = (() => {
    // --- Nordic UART Service UUIDs ---
    const UART_SERVICE_UUID     = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    const UART_TX_CHAR_UUID     = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify (scooter → us)
    const UART_RX_CHAR_UUID     = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write  (us → scooter)

    // Fallback: Generic HM-10 style
    const FALLBACK_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
    const FALLBACK_CHAR_UUID    = '0000ffe1-0000-1000-8000-00805f9b34fb';

    // 🎮 BRIGHTWAY / NAVEE proprietary UUIDs (older models S65/V40/V50)
    const BRIGHTWAY_SERVICE_UUID = '00000101-0065-6c62-2e74-6f696d2e696d';
    const BRIGHTWAY_TXRX_UUID    = '00000100-0065-6c62-2e74-6f696d2e696d';
    const BRIGHTWAY_BUTTON_UUID  = '00000102-0065-6c62-2e74-6f696d2e696d';

    // 🛴 ST3 PRO REAL UUIDs — discovered via nRF Connect GATT dump
    // Main proprietary service with 9 characteristics (6AA5xxxx family)
    const ST3_SERVICE_UUID       = '87290102-3c51-43b1-a1a9-11b9dc38478b';
    const ST3_CHAR_BASE          = '003a416fbb0b'; // last 6 bytes shared by all ST3 chars
    // UART-pipe service — B003 has CCCD (notify), B001/B002 are write
    const ST3_UART_SERVICE_UUID  = '0000d0ff-3c17-d293-8e48-14fe2e4da212';
    // B00x chars: try standard 16-bit base AND the D0FF custom base
    const ST3_B001_STD           = '0000b001-0000-1000-8000-00805f9b34fb';
    const ST3_B002_STD           = '0000b002-0000-1000-8000-00805f9b34fb';
    const ST3_B003_STD           = '0000b003-0000-1000-8000-00805f9b34fb'; // NOTIFY (CCCD confirmed)
    const ST3_B001_CUSTOM        = '0000b001-3c17-d293-8e48-14fe2e4da212';
    const ST3_B002_CUSTOM        = '0000b002-3c17-d293-8e48-14fe2e4da212';
    const ST3_B003_CUSTOM        = '0000b003-3c17-d293-8e48-14fe2e4da212'; // NOTIFY (CCCD confirmed)

    // Extended pool — Web Bluetooth requires ALL services you might access to be
    // declared upfront in optionalServices, even for auto-discovery.
    const ALL_OPTIONAL_SERVICES = [
        '87290102-3c51-43b1-a1a9-11b9dc38478b', // ⭐⭐ ST3 Pro main service (CONFIRMED)
        '0000d0ff-3c17-d293-8e48-14fe2e4da212', // ⭐⭐ ST3 Pro UART pipe (B003=notify CONFIRMED)
        '00001812-0000-1000-8000-00805f9b34fb', // HID (advertised type)
        '00000101-0065-6c62-2e74-6f696d2e696d', // Brightway/Navee (older models)
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART (NUS)
        '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 FFE0
        '0000fff0-0000-1000-8000-00805f9b34fb', // Generic FFF0
        '0000fee7-0000-1000-8000-00805f9b34fb', // Ninebot/Segway FEE7
        '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
        '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
        '0000fd00-0000-1000-8000-00805f9b34fb', // Custom FD00
        '0000ae00-0000-1000-8000-00805f9b34fb', // Custom AE00
        '0000be00-0000-1000-8000-00805f9b34fb', // Custom BE00
        '0000ab00-0000-1000-8000-00805f9b34fb', // Custom AB00
        '00001234-0000-1000-8000-00805f9b34fb', // Custom 1234
        '0000a002-0000-1000-8000-00805f9b34fb', // Custom A002
    ];

    // HID characteristic UUIDs
    const HID_SERVICE_UUID       = '00001812-0000-1000-8000-00805f9b34fb';
    const HID_REPORT_UUID        = '00002a4d-0000-1000-8000-00805f9b34fb';
    const HID_REPORT_MAP_UUID    = '00002a4b-0000-1000-8000-00805f9b34fb';
    const HID_CONTROL_UUID       = '00002a4e-0000-1000-8000-00805f9b34fb';

    // State
    let device = null;
    let server = null;
    let service = null;
    let txChar = null;  // We READ from this (notifications)
    let rxChar = null;  // We WRITE to this
    let connected = false;
    let reconnecting = false;
    let useNordic = true;
    let useWriteWithoutResponse = false; // Detected at connect time
    let st3Mode = false;   // ST3 Pro / D0FF service — protocol unknown, block 0x5A writes
    let mockMode = false;
    let mockSettings = {
        region: 0x01,
        speedLimit: 20,
        cruiseControl: false,
        kersLevel: 2,
        lightOn: false,
        locked: false,
        accelCurve: 1,
        motorLimit: 20,
        startupSpeed: 5,
    };
    let mockInputs = {
        brakePressed: false,
        throttlePressed: false,
    };

    // --- Receive buffer for packet reassembly ---
    // Real BLE has ~20-byte MTU, scooter responses can span multiple notifications
    let rxBuffer = new Uint8Array(0);
    let rxBufferTimeout = null;

    function setMockMode(enabled) {
        mockMode = enabled;
        if (enabled) {
            log('Mock BLE mode enabled');
            mockSettings = {
                region: 0x01,
                speedLimit: 20,
                cruiseControl: false,
                kersLevel: 2,
                lightOn: false,
                locked: false,
                accelCurve: 1,
                motorLimit: 20,
                startupSpeed: 5,
            };
            mockInputs = {
                brakePressed: false,
                throttlePressed: false,
            };
        } else {
            log('Mock BLE mode disabled');
        }
    }

    function setMockInputs(inputs) {
        mockInputs = { ...mockInputs, ...inputs };
    }

    // Event listeners
    const listeners = {
        connected: [],
        disconnected: [],
        data: [],
        error: [],
        log: [],
    };

    function on(event, callback) {
        if (listeners[event]) {
            listeners[event].push(callback);
        }
    }

    function off(event, callback) {
        if (listeners[event]) {
            listeners[event] = listeners[event].filter(cb => cb !== callback);
        }
    }

    function emit(event, data) {
        if (listeners[event]) {
            listeners[event].forEach(cb => {
                try { cb(data); } catch (e) { console.error(`Event handler error [${event}]:`, e); }
            });
        }
    }

    function log(msg, type = 'info') {
        const entry = { time: new Date().toISOString(), message: msg, type };
        emit('log', entry);
        if (type === 'error') {
            console.error(`[BLE] ${msg}`);
        } else {
            console.log(`[BLE] ${msg}`);
        }
    }

    // --- Check if Web Bluetooth is available ---
    function isSupported() {
        return !!navigator.bluetooth;
    }

    // --- Scan and Connect (filtered mode) ---
    async function scanAndConnect() {
        if (!isSupported()) {
            const err = 'Web Bluetooth not supported. Use Chrome/Edge/Opera.';
            log(err, 'error');
            emit('error', { message: err });
            throw new Error(err);
        }

        log('Scanning for Navee scooters (filtered)...');

        try {
            // Request device — comprehensive name prefix filters for all known Navee models
            device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Navee' },
                    { namePrefix: 'NAVEE' },
                    { namePrefix: 'NKT' },
                    { namePrefix: 'BW' },       // Brightway OEM
                    { namePrefix: 'Mi Scooter' },
                    { namePrefix: 'GT3' },       // Navee GT3 series
                    { namePrefix: 'GT5' },       // Navee GT5 series
                    { namePrefix: 'ST3' },       // Navee ST3 series
                    { namePrefix: 'ST5' },       // Navee ST5 series
                    { namePrefix: 'N65' },       // Navee N65 / N65i
                    { namePrefix: 'S65' },       // Navee S65
                    { namePrefix: 'S60' },       // Navee S60
                    { namePrefix: 'V40' },       // Navee V40
                    { namePrefix: 'V50' },       // Navee V50
                    { namePrefix: 'G5' },        // Navee G5 variants
                    { namePrefix: 'N4' },        // Navee N40 etc.
                ],
                optionalServices: ALL_OPTIONAL_SERVICES,
            });

            return await connectToDevice(device);

        } catch (err) {
            if (err.name === 'NotFoundError') {
                log('Scan cancelled by user', 'warn');
            } else {
                log(`Connection failed: ${err.message}`, 'error');
                emit('error', { message: err.message });
            }
            throw err;
        }
    }

    // --- Scan ALL devices (no name filter — last resort) ---
    async function scanAll() {
        if (!isSupported()) {
            const err = 'Web Bluetooth not supported. Use Chrome/Edge/Opera.';
            log(err, 'error');
            emit('error', { message: err });
            throw new Error(err);
        }

        log('Scanning ALL BLE devices (unfiltered — showing everything)...');

        try {
            device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ALL_OPTIONAL_SERVICES,
            });

            return await connectToDevice(device);

        } catch (err) {
            if (err.name === 'NotFoundError') {
                log('Scan cancelled by user', 'warn');
            } else {
                log(`Connection failed: ${err.message}`, 'error');
                emit('error', { message: err.message });
            }
            throw err;
        }
    }

    // --- Shared connection logic after device selection ---
    async function connectToDevice(selectedDevice) {
        device = selectedDevice;
        log(`Device found: ${device.name || 'Unknown'} (${device.id})`);

        // Remove any existing listener first to avoid stacking duplicates
        // on reconnect cycles — duplicate listeners = handler fires 2x = chain-disconnect
        device.removeEventListener('gattserverdisconnected', onDisconnected);
        device.addEventListener('gattserverdisconnected', onDisconnected);

        // Only connect if not already connected (guards against double-connect
        // from the reconnect handler calling gatt.connect() before us)
        if (!device.gatt.connected) {
            log('Connecting to GATT server...');
            server = await device.gatt.connect();
        } else {
            log('GATT already connected — skipping connect()');
            server = device.gatt;
        }
        log('GATT connected');

        // --- Service Discovery ---
        // Order: ST3 Pro confirmed UUIDs first, then fallbacks
        let serviceFound = false;

        // 🛔 ST3 PRO: D0FF UART pipe — B003 has CCCD (notify CONFIRMED by nRF Connect)
        // B003 = scooter→phone (TX), B001/B002 = phone→scooter (RX)
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(ST3_UART_SERVICE_UUID);
                log('✓ ST3 Pro UART pipe (D0FF) found!');

                // Try custom-base B00x first, then standard 16-bit
                let notifyChar = null, writeChar = null;
                const b3candidates = [ST3_B003_CUSTOM, ST3_B003_STD];
                const b1candidates = [ST3_B001_CUSTOM, ST3_B001_STD, ST3_B002_CUSTOM, ST3_B002_STD];

                for (const uuid of b3candidates) {
                    try { notifyChar = await service.getCharacteristic(uuid); log('  B003 notify: ' + uuid); break; } catch(_) {}
                }
                for (const uuid of b1candidates) {
                    try { writeChar = await service.getCharacteristic(uuid); log('  Write char: ' + uuid); break; } catch(_) {}
                }

                if (!notifyChar && !writeChar) {
                    // Fall back: enumerate all chars and sniff by properties
                    const chars = await service.getCharacteristics();
                    log('  D0FF chars: ' + chars.length + ' — sniffing properties...');
                    for (const c of chars) {
                        log('    ' + c.uuid + ' notify:' + c.properties.notify + ' write:' + c.properties.write);
                        if ((c.properties.notify || c.properties.indicate) && !notifyChar) notifyChar = c;
                        if ((c.properties.write || c.properties.writeWithoutResponse) && !writeChar) writeChar = c;
                    }
                }

                if (notifyChar) {
                    txChar = notifyChar;
                    rxChar = writeChar || notifyChar;
                    useNordic = false;
                    st3Mode = true;   // ⭐ SET HERE — no UUID fragility
                    serviceFound = true;
                    log('✓ ST3 Pro D0FF connected! TX:' + txChar.uuid + ' RX:' + rxChar.uuid);
                }
            } catch (e) {
                log('  D0FF attempt: ' + e.message);
            }
        }

        // 🛴 ST3 PRO: main 87290102 service (9x 6AA5xxxx characteristics)
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(ST3_SERVICE_UUID);
                log('✓ ST3 Pro main service (87290102) found! Enumerating characteristics...');
                const chars = await service.getCharacteristics();
                log('  Found ' + chars.length + ' characteristics:');

                let notifyChar = null, writeChar = null;
                for (const c of chars) {
                    log('    ' + c.uuid + ' | notify:' + c.properties.notify + ' write:' + c.properties.write + ' writeNoResp:' + c.properties.writeWithoutResponse + ' read:' + c.properties.read);
                    if ((c.properties.notify || c.properties.indicate) && !notifyChar) notifyChar = c;
                    if ((c.properties.write || c.properties.writeWithoutResponse) && !writeChar) writeChar = c;
                }

                if (notifyChar || writeChar) {
                    txChar = notifyChar || writeChar;
                    rxChar = writeChar || notifyChar;
                    useNordic = false;
                    st3Mode = true;   // ⭐ SET HERE too
                    serviceFound = true;
                    log('✓ ST3 main service connected');
                } else {
                    log('⚠ 87290102 found but no notify/write chars — may need auth first');
                }
            } catch (e) {
                log('  87290102 attempt: ' + e.message);
            }
        }
        // nRF Connect confirmed Device Type: HID on this scooter
        // Note: Chrome desktop BLOCKS HID, but Bluefy on iOS may allow it
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(HID_SERVICE_UUID);
                log('✓ HID service found! Discovering report characteristics...');
                const chars = await service.getCharacteristics();
                log('  HID characteristics: ' + chars.length);

                let inputReport  = null; // scooter → phone (notify)
                let outputReport = null; // phone → scooter (write)

                for (const c of chars) {
                    const props = c.properties;
                    log('    char: ' + c.uuid + ' | notify:' + props.notify + ' write:' + props.write + ' writeNoResp:' + props.writeWithoutResponse);
                    if ((props.notify || props.indicate) && !inputReport)  inputReport  = c;
                    if ((props.write || props.writeWithoutResponse) && !outputReport) outputReport = c;
                }

                if (inputReport && outputReport) {
                    txChar = inputReport;
                    rxChar = outputReport;
                    useNordic = false;
                    serviceFound = true;
                    log('✓ HID TX (input report):  ' + txChar.uuid);
                    log('✓ HID RX (output report): ' + rxChar.uuid);
                } else if (inputReport) {
                    // Single-char HID (some devices reuse same char)
                    txChar = inputReport;
                    rxChar = inputReport;
                    useNordic = false;
                    serviceFound = true;
                    log('✓ HID single-char: ' + txChar.uuid);
                } else {
                    log('⚠ HID service found but no usable report characteristics');
                }
            } catch (e) {
                log('  HID attempt: ' + e.message);
            }
        }

        // 1️⃣ Brightway/Navee proprietary service (S65, V40, V50, older models)
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(BRIGHTWAY_SERVICE_UUID);
                const char = await service.getCharacteristic(BRIGHTWAY_TXRX_UUID);
                txChar = char;
                rxChar = char;
                useNordic = false;
                serviceFound = true;
                log('✓ Brightway/Navee service found (ST3 Pro / S65 / V40 / GT series)');
                log('  Service: ' + BRIGHTWAY_SERVICE_UUID);
                log('  TX+RX char: ' + BRIGHTWAY_TXRX_UUID);
                try {
                    const btnChar = await service.getCharacteristic(BRIGHTWAY_BUTTON_UUID);
                    // Use button char for TX notifications if available
                    txChar = btnChar;
                    log('  Button notify char: ' + BRIGHTWAY_BUTTON_UUID);
                } catch (_) { /* no button char, txChar stays as TXRX */ }
            } catch (_) { /* not Brightway */ }
        }

        // 1️⃣ Nordic UART (NUS) — older/generic Navee or third-party BLE modules
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(UART_SERVICE_UUID);
                txChar  = await service.getCharacteristic(UART_TX_CHAR_UUID);
                rxChar  = await service.getCharacteristic(UART_RX_CHAR_UUID);
                useNordic = true;
                serviceFound = true;
                log('✓ Nordic UART Service (NUS) found');
            } catch (_) { /* not NUS */ }
        }

        // 2️⃣ HM-10 FFE0 fallback
        if (!serviceFound) {
            try {
                service = await server.getPrimaryService(FALLBACK_SERVICE_UUID);
                const char = await service.getCharacteristic(FALLBACK_CHAR_UUID);
                txChar = char;
                rxChar = char;
                useNordic = false;
                serviceFound = true;
                log('✓ Fallback service (FFE0/FFE1) found');
            } catch (_) { /* not FFE0 either */ }
        }

        // 3️⃣ Auto-discovery — walk every declared optional service and sniff
        //    for a characteristic with NOTIFY (→ use as TX) and one with WRITE (→ RX)
        if (!serviceFound) {
            log('Known services not found — running auto-discovery across all optional services...');
            for (const svcUUID of ALL_OPTIONAL_SERVICES) {
                if (svcUUID === UART_SERVICE_UUID || svcUUID === FALLBACK_SERVICE_UUID) continue;
                try {
                    const svc   = await server.getPrimaryService(svcUUID);
                    const chars = await svc.getCharacteristics();
                    log(`  Checking ${svcUUID} — ${chars.length} characteristic(s)`);

                    let foundTx = null, foundRx = null;
                    for (const c of chars) {
                        if (c.properties.notify || c.properties.indicate) foundTx = c;
                        if (c.properties.write || c.properties.writeWithoutResponse) foundRx = c;
                    }

                    if (foundTx && foundRx) {
                        service = svc;
                        txChar  = foundTx;
                        rxChar  = foundRx;
                        useNordic = false;
                        serviceFound = true;
                        log(`✓ Auto-discovered service: ${svcUUID}`);
                        log(`  TX char: ${foundTx.uuid}`);
                        log(`  RX char: ${foundRx.uuid}`);
                        break;
                    } else if (foundTx) {
                        // Single-char service (TX=RX same char, e.g. FFE1 style)
                        service = svc;
                        txChar  = foundTx;
                        rxChar  = foundTx;
                        useNordic = false;
                        serviceFound = true;
                        log(`✓ Auto-discovered single-char service: ${svcUUID}`);
                        break;
                    }
                } catch (_) { /* service not on device, skip */ }
            }
        }

        if (!serviceFound) {
            throw new Error(
                'No compatible BLE service found on device. ' +
                'Your scooter may use an undocumented UUID — ' +
                'use the Scanner tab to inspect raw services.'
            );
        }

        // Detect write method from characteristic properties
        if (rxChar.properties) {
            if (rxChar.properties.writeWithoutResponse && !rxChar.properties.write) {
                useWriteWithoutResponse = true;
                log('Write mode: writeValueWithoutResponse (detected from properties)');
            } else if (rxChar.properties.write) {
                useWriteWithoutResponse = false;
                log('Write mode: writeValue (detected from properties)');
            } else if (rxChar.properties.writeWithoutResponse) {
                // Has both — prefer writeWithoutResponse for speed
                useWriteWithoutResponse = true;
                log('Write mode: writeValueWithoutResponse (preferred, both available)');
            }
        }

        // Reset receive buffer
        rxBuffer = new Uint8Array(0);

        // Subscribe to notifications
        await txChar.startNotifications();
        txChar.addEventListener('characteristicvaluechanged', onTxNotification);
        log('Subscribed to notifications');

        connected = true;
        // st3Mode is already set in the D0FF/87290102 discovery blocks above

        emit('connected', {
            name: device.name || 'Unknown',
            id: device.id,
            serviceType: st3Mode ? 'ST3 Pro (D0FF)' : (useNordic ? 'Nordic UART' : 'FFE0 Generic'),
        });

        log(`✓ Connected to ${device.name}`);
        return getDeviceInfo();
    }

    // --- Disconnect ---
    async function disconnect() {
        const wasMock = mockMode;
        if (mockMode) {
            mockMode = false;
        }
        if (device && device.gatt.connected) {
            log('Disconnecting...');
            try {
                if (txChar) {
                    txChar.removeEventListener('characteristicvaluechanged', onTxNotification);
                    await txChar.stopNotifications();
                }
            } catch (e) { /* ignore */ }
            device.gatt.disconnect();
        }
        cleanup();
        if (wasMock) {
            onDisconnected();
        }
    }

    function cleanup() {
        connected = false;
        st3Mode = false;
        server = null;
        service = null;
        txChar = null;
        rxChar = null;
        rxBuffer = new Uint8Array(0);
        if (rxBufferTimeout) {
            clearTimeout(rxBufferTimeout);
            rxBufferTimeout = null;
        }
    }

    function onDisconnected() {
        log('Device disconnected', 'warn');
        cleanup();
        emit('disconnected', { wasReconnect: reconnecting });

        // Auto-reconnect attempt
        if (!reconnecting && device) {
            reconnecting = true;
            log('Attempting auto-reconnect in 3s...');
            setTimeout(async () => {
                try {
                    if (device && device.gatt) {
                        // Let connectToDevice() handle gatt.connect() — don't call it here too
                        // or you get a double-connect which drops the link immediately
                        await connectToDevice(device);
                    }
                    reconnecting = false;
                } catch (e) {
                    reconnecting = false;
                    log('Auto-reconnect failed: ' + e.message, 'error');
                    emit('error', { message: 'Auto-reconnect failed: ' + e.message });
                }
            }, 3000);
        }
    }

    // --- Handle incoming data with packet reassembly ---
    function onTxNotification(event) {
        const value = event.target.value;
        const chunk = new Uint8Array(value.buffer);
        const hex = NaveeProtocol.toHexString(chunk);
        log(`← RX chunk: ${hex} (${chunk.length} bytes)`);

        // Append chunk to receive buffer
        const newBuffer = new Uint8Array(rxBuffer.length + chunk.length);
        newBuffer.set(rxBuffer);
        newBuffer.set(chunk, rxBuffer.length);
        rxBuffer = newBuffer;

        // Reset the buffer flush timeout — if we don't get more data within 100ms,
        // flush whatever we have (handles edge cases where footer is missing)
        if (rxBufferTimeout) clearTimeout(rxBufferTimeout);
        rxBufferTimeout = setTimeout(() => {
            flushRxBuffer(true);
        }, 100);

        // Try to extract complete frames immediately
        flushRxBuffer(false);
    }

    function flushRxBuffer(force) {
        if (rxBuffer.length === 0) return;

        const Protocol = st3Mode ? ST3Protocol : NaveeProtocol;
        const { frames, remainder } = Protocol.extractFrames(rxBuffer);

        for (const frame of frames) {
            const hex = NaveeProtocol.toHexString(frame);
            log(`← RX packet: ${hex}`);
            const parsed = Protocol.parseResponse(frame);
            
            if (st3Mode) {
                if (parsed.valid && parsed.error === 0) {
                    processST3Telemetry(parsed);
                } else if (parsed.valid) {
                    log(`⚠ ST3 Error ${parsed.error} on CMD ${parsed.commandHex}`, 'warn');
                }
            } else {
                emit('data', { raw: frame, hex, parsed });
            }
        }

        if (force && remainder.length > 0) {
            // Force-parse whatever's left as a best-effort packet
            const hex = NaveeProtocol.toHexString(remainder);
            log(`← RX remainder (forced): ${hex}`);
            const parsed = Protocol.parseResponse(remainder);
            if (!st3Mode) {
                emit('data', { raw: remainder, hex, parsed });
            }
            rxBuffer = new Uint8Array(0);
        } else {
            rxBuffer = remainder;
        }
    }

    function processST3Telemetry(parsed) {
        const p = parsed.payload;
        const eventData = {};

        if (parsed.command === 0x90 || parsed.command === 0x70) {
            // Vehicle / Home Report
            if (p.length >= 8) {
                eventData.speedMode = p[1]; // 0=Pedestrian, 1=Drive, 2=Sport, 3=Custom
                eventData.batteryPercent = p[2];
                eventData.isCharging = p[4] === 1;
                eventData.locked = p[7] ? p[7] - 1 : 0;
            }
        } else if (parsed.command === 0x91) {
            // Subpage 1
            if (p.length >= 9) {
                eventData.speed = p[2];
                eventData.batteryPercent = p[0];
                eventData.odometer = p[8]; // Partial odometer
            }
        } else if (parsed.command === 0x92) {
            // Subpage 2
            if (p.length >= 14) {
                eventData.batteryPercent = p[0];
                eventData.speed = (p[2] | (p[3]<<8)) / 10;
                eventData.odometer = (p[12] | (p[13]<<8)) / 10;
            }
        } else if (parsed.command === 0x72) {
            // Battery details
            if (p.length >= 12) {
                eventData.batteryPercent = p[1];
                eventData.voltage = (p[2] | (p[3]<<8) | (p[4]<<16) | (p[5]<<24)) / 1000;
                eventData.current = (p[6] | (p[7]<<8) | (p[8]<<16) | (p[9]<<24)) / 1000;
                eventData.batteryTemp = p[11];
            }
        }

        if (Object.keys(eventData).length > 0) {
            emit('telemetry', eventData);
        }
    }

    // --- Send data to scooter ---
    async function write(data) {
        if (mockMode) {
            const hex = NaveeProtocol.toHexString(data);
            log(`→ TX (Simulated): ${hex}`);
            return;
        }

        // Prevent legacy Ninebot 0x5A commands from killing the ST3 Pro connection
        if (st3Mode) {
            const dataArr = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (dataArr[0] !== 0x55) {
                const hex = NaveeProtocol.toHexString(dataArr);
                log(`⛔ TX BLOCKED (ST3 Pro — invalid legacy write): ${hex}`, 'warn');
                return;
            }
        }

        if (!connected || !rxChar) {
            throw new Error('Not connected');
        }

        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        const hex = NaveeProtocol.toHexString(data);
        log(`→ TX: ${hex}`);

        // BLE has a 20-byte MTU limit typically, chunk if needed
        const chunkSize = 20;
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.slice(i, i + chunkSize);

            // Use the correct write method based on characteristic properties
            if (useWriteWithoutResponse) {
                await rxChar.writeValueWithoutResponse(chunk);
            } else {
                await rxChar.writeValue(chunk);
            }

            if (i + chunkSize < data.length) {
                await new Promise(r => setTimeout(r, 50));
            }
        }
    }

    // --- Send a protocol command ---
    async function sendCommand(command, payload = []) {
        if (mockMode) {
            const packet = NaveeProtocol.buildPacket(command, payload);
            const hex = NaveeProtocol.toHexString(packet);
            log(`→ TX (Simulated CMD): ${hex}`);

            // Update mock settings on write
            if (command === NaveeProtocol.CMD.WRITE_REGION) mockSettings.region = payload[0];
            if (command === NaveeProtocol.CMD.WRITE_SPEED_LIMIT) mockSettings.speedLimit = payload[0];
            if (command === NaveeProtocol.CMD.WRITE_CRUISE) mockSettings.cruiseControl = !!payload[0];
            if (command === NaveeProtocol.CMD.WRITE_KERS) mockSettings.kersLevel = payload[0];
            if (command === NaveeProtocol.CMD.WRITE_LOCK) mockSettings.locked = !!payload[0];
            if (command === NaveeProtocol.CMD.WRITE_LIGHT) mockSettings.lightOn = !!payload[0];
            if (command === NaveeProtocol.CMD.WRITE_ACCEL_CURVE) mockSettings.accelCurve = payload[0];
            if (command === NaveeProtocol.CMD.WRITE_MOTOR_LIMIT) mockSettings.motorLimit = payload[0];
            if (command === NaveeProtocol.CMD.WRITE_STARTUP_SPEED) mockSettings.startupSpeed = payload[0];

            // Trigger asynchronous simulated response
            setTimeout(() => {
                let respPayload = [];
                switch (command) {
                    case NaveeProtocol.CMD.READ_SPEED: {
                        // speed in 0.1 km/h
                        const speedVal = Math.round((15 + Math.random() * 10) * 10);
                        respPayload = [
                            speedVal & 0xFF, 
                            (speedVal >> 8) & 0xFF,
                            mockInputs.brakePressed ? 1 : 0,
                            mockInputs.throttlePressed ? 1 : 0
                        ];
                        break;
                    }
                    case NaveeProtocol.CMD.READ_BATTERY: {
                        const percent = 85;
                        const volt = Math.round(38.5 * 100);
                        respPayload = [percent, volt & 0xFF, (volt >> 8) & 0xFF];
                        break;
                    }
                    case NaveeProtocol.CMD.READ_TEMPERATURE: {
                        // temps in 0.1 C
                        const mot = Math.round(35.2 * 10);
                        const ctrl = Math.round(32.1 * 10);
                        const bat = Math.round(28.5 * 10);
                        respPayload = [
                            mot & 0xFF, (mot >> 8) & 0xFF,
                            ctrl & 0xFF, (ctrl >> 8) & 0xFF,
                            bat & 0xFF, (bat >> 8) & 0xFF
                        ];
                        break;
                    }
                    case NaveeProtocol.CMD.READ_ODOMETER: {
                        // odometer in meters
                        const odo = Math.round(124.5 * 1000);
                        respPayload = [odo & 0xFF, (odo >> 8) & 0xFF, (odo >> 16) & 0xFF, (odo >> 24) & 0xFF];
                        break;
                    }
                    case NaveeProtocol.CMD.READ_SETTINGS:
                        respPayload = [
                            mockSettings.region,
                            mockSettings.speedLimit,
                            mockSettings.cruiseControl ? 1 : 0,
                            mockSettings.kersLevel,
                            mockSettings.lightOn ? 1 : 0,
                            mockSettings.locked ? 1 : 0
                        ];
                        break;
                    case NaveeProtocol.CMD.READ_FIRMWARE:
                        respPayload = [1, 2, 4];
                        break;
                    case NaveeProtocol.CMD.READ_SERIAL:
                        respPayload = Array.from("N6523G123456").map(c => c.charCodeAt(0));
                        break;
                    default:
                        respPayload = [...payload];
                        break;
                }

                const respCmd = NaveeProtocol.nibbleSwap(command);
                const respPacket = NaveeProtocol.buildPacket(respCmd, respPayload);
                const respHex = NaveeProtocol.toHexString(respPacket);
                log(`← RX: ${respHex}`);

                const parsed = NaveeProtocol.parseResponse(respPacket);
                emit('data', { raw: respPacket, hex: respHex, parsed });
            }, 50);

            return packet;
        }

        // ST3 Pro Command Translation
        if (st3Mode) {
            let st3Cmd, st3Payload = [];
            switch (command) {
                case NaveeProtocol.CMD.READ_SPEED:
                case NaveeProtocol.CMD.READ_ODOMETER:
                case NaveeProtocol.CMD.READ_ALL_TELEMETRY:
                    st3Cmd = ST3Protocol.CMD.READ_VEHICLE; // 0x70
                    break;
                case NaveeProtocol.CMD.READ_BATTERY:
                    st3Cmd = ST3Protocol.CMD.READ_BATTERY; // 0x72
                    break;
                case NaveeProtocol.CMD.WRITE_SPEED_LIMIT:
                    st3Cmd = ST3Protocol.CMD.WRITE_SPEED_LIMIT; // 0x6B
                    st3Payload = [payload[0]];
                    break;
                case NaveeProtocol.CMD.WRITE_STARTUP_SPEED:
                    st3Cmd = 0x6A; // Start speed limit
                    st3Payload = [payload[0]];
                    break;
                case NaveeProtocol.CMD.WRITE_LIGHT:
                    st3Cmd = 0x54; // Headlight control
                    st3Payload = [payload[0]];
                    break;
                case NaveeProtocol.CMD.WRITE_LOCK:
                    st3Cmd = 0x51; // Lock control
                    st3Payload = [payload[0]];
                    break;
                case NaveeProtocol.CMD.WRITE_CRUISE:
                    st3Cmd = 0x52; // Cruise control
                    st3Payload = [payload[0]];
                    break;
                case NaveeProtocol.CMD.WRITE_KERS:
                    st3Cmd = 0x53; // Energy recovery
                    st3Payload = [payload[0]];
                    break;
                // Add more mappings as discovered
            }

            if (st3Cmd) {
                const packet = st3Payload.length > 0 
                    ? ST3Protocol.buildWriteCommand(st3Cmd, st3Payload) 
                    : ST3Protocol.buildReadCommand(st3Cmd);
                return write(packet);
            } else {
                log(`⚠ Unmapped legacy command for ST3: 0x${command.toString(16)}`, 'warn');
                return;
            }
        }

        const packet = NaveeProtocol.buildPacket(command, payload);
        await write(packet);
        return packet;
    }

    // --- Convenience: send raw hex string ---
    async function sendHex(hexString) {
        if (mockMode) {
            log(`→ TX (Simulated Hex): ${hexString}`);
            return NaveeProtocol.fromHexString(hexString);
        }
        const data = NaveeProtocol.fromHexString(hexString);
        await write(data);
        return data;
    }

    // --- Get device info ---
    function getDeviceInfo() {
        return {
            name: mockMode ? 'Navee S65 (Demo)' : (device ? device.name : null),
            id: mockMode ? 'demo-device-id' : (device ? device.id : null),
            connected: connected || mockMode,
            serviceType: mockMode ? 'Nordic UART (Simulated)' : (useNordic ? 'Nordic UART' : 'FFE0 Generic'),
        };
    }

    // Keep the BLE link warm without sending protocol commands.
    // Does a readValue on the TX characteristic (B003) — safe, read-only, no side effects.
    async function keepAlivePing() {
        if (!connected || !txChar) return;
        try {
            await txChar.readValue();
        } catch (_) {
            // If readValue fails (write-only char), try a zero-byte write instead
            try {
                await rxChar.writeValueWithoutResponse(new Uint8Array([0x00]));
            } catch (_2) { /* both failed — connection probably dropped */ }
        }
    }

    function isConnected() {
        return connected || mockMode;
    }

    // --- Expose GATT server for Scanner module ---
    function _getServer() {
        return server;
    }

    return {
        isSupported,
        scanAndConnect,
        scanAll,
        disconnect,
        write,
        sendCommand,
        sendHex,
        getDeviceInfo,
        isConnected,
        isST3Mode: () => st3Mode,
        keepAlivePing,
        setMockMode,
        setMockInputs,
        _getServer,
        on,
        off,
        emit,
        log,
        // Expose UUIDs for reference
        UUIDS: {
            UART_SERVICE: UART_SERVICE_UUID,
            UART_TX: UART_TX_CHAR_UUID,
            UART_RX: UART_RX_CHAR_UUID,
            FALLBACK_SERVICE: FALLBACK_SERVICE_UUID,
            FALLBACK_CHAR: FALLBACK_CHAR_UUID,
        },
    };
})();
