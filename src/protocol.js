// ============================================================
// NaveeHack — protocol.js
// Navee/Brightway Packet Protocol Engine
// "Because every scooter speaks in tongues" — ENI
// ============================================================

const NaveeProtocol = (() => {
    // --- Constants ---
    const HEADER = 0x5A;
    const FOOTER = 0xA5;

    // Known command bytes (research-based, Brightway platform)
    const CMD = {
        // Telemetry reads
        READ_SPEED:         0x10,
        READ_BATTERY:       0x11,
        READ_ODOMETER:      0x12,
        READ_TEMPERATURE:   0x13,
        READ_FIRMWARE:      0x14,
        READ_SERIAL:        0x15,
        READ_ERROR:         0x16,
        READ_SETTINGS:      0x17,
        READ_TRIP:          0x18,
        READ_VOLTAGE:       0x19,
        READ_CURRENT:       0x1A,
        READ_ALL_TELEMETRY: 0x1F,

        // Configuration writes
        WRITE_SPEED_LIMIT:  0x20,
        WRITE_REGION:       0x21,
        WRITE_CRUISE:       0x22,
        WRITE_KERS:         0x23,
        WRITE_LOCK:         0x24,
        WRITE_LIGHT:        0x25,
        WRITE_ACCEL_CURVE:  0x26,
        WRITE_MOTOR_LIMIT:  0x27,
        WRITE_STARTUP_SPEED:0x28,

        // System
        PING:               0x01,
        RESET:              0xFE,
        DFU_MODE:           0xFF,
    };

    // Region codes
    const REGION = {
        DE: 0x01,   // Germany — 20 km/h
        EU: 0x02,   // Europe — 25 km/h
        US: 0x03,   // USA — 30 km/h (15.5 mph limit states)
        CN: 0x04,   // China — 25 km/h
        UNRESTRICTED: 0x00, // No limit
    };

    const REGION_SPEED_MAP = {
        0x01: 20,
        0x02: 25,
        0x03: 30,
        0x04: 25,
        0x00: 0,  // 0 = no limit
    };

    const REGION_NAMES = {
        0x01: 'Germany (20 km/h)',
        0x02: 'Europe (25 km/h)',
        0x03: 'USA (30 km/h)',
        0x04: 'China (25 km/h)',
        0x00: 'Unrestricted',
    };

    // --- CRC-16 (Modbus variant used by Brightway) ---
    function crc16(data) {
        let crc = 0xFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                if (crc & 0x0001) {
                    crc = (crc >> 1) ^ 0xA001;
                } else {
                    crc >>= 1;
                }
            }
        }
        return crc & 0xFFFF;
    }

    // --- Nibble swap for response command validation ---
    function nibbleSwap(byte) {
        return ((byte & 0x0F) << 4) | ((byte & 0xF0) >> 4);
    }

    // --- Build a packet ---
    function buildPacket(command, payload = []) {
        const len = payload.length;
        // Frame: [HEADER] [CMD] [LEN] [PAYLOAD...] [CRC_LO] [CRC_HI] [FOOTER]
        const frame = new Uint8Array(6 + len);
        frame[0] = HEADER;
        frame[1] = command;
        frame[2] = len;
        for (let i = 0; i < len; i++) {
            frame[3 + i] = payload[i];
        }
        const crcData = frame.slice(1, 3 + len); // CMD + LEN + PAYLOAD
        const crc = crc16(crcData);
        frame[3 + len] = crc & 0xFF;       // CRC low byte
        frame[4 + len] = (crc >> 8) & 0xFF; // CRC high byte
        frame[5 + len] = FOOTER;            // Footer byte 0xA5
        return frame;
    }

    // --- Parse a response packet ---
    // Tolerates packets with or without the trailing 0xA5 footer
    function parseResponse(data) {
        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        if (data.length < 5) {
            return { valid: false, error: 'Packet too short', raw: data };
        }

        if (data[0] !== HEADER) {
            return { valid: false, error: `Invalid header: 0x${data[0].toString(16)}`, raw: data };
        }

        const command = data[1];
        const length = data[2];

        // Sanity-check length against available data
        // Minimum frame: HEADER(1) + CMD(1) + LEN(1) + PAYLOAD(length) + CRC(2) = 5 + length
        if (data.length < 5 + length) {
            return { valid: false, error: 'Packet truncated', raw: data };
        }

        const payload = data.slice(3, 3 + length);
        const crcLo = data[3 + length];
        const crcHi = data[4 + length];
        const receivedCrc = crcLo | (crcHi << 8);

        // Check for optional footer byte
        const hasFooter = data.length > 5 + length && data[5 + length] === FOOTER;

        // Verify CRC over CMD + LEN + PAYLOAD
        const crcData = data.slice(1, 3 + length);
        const calculatedCrc = crc16(crcData);

        const valid = receivedCrc === calculatedCrc;

        return {
            valid,
            command,
            commandHex: `0x${command.toString(16).padStart(2, '0')}`,
            isResponse: command === nibbleSwap(command),
            originalCommand: nibbleSwap(command),
            length,
            payload: Array.from(payload),
            payloadHex: Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(' '),
            crc: { received: receivedCrc, calculated: calculatedCrc },
            hasFooter,
            raw: data,
            error: valid ? null : 'CRC mismatch',
        };
    }

    // --- Extract complete frames from a byte stream ---
    // Returns { frames: [Uint8Array, ...], remainder: Uint8Array }
    // Used by BLE receive buffer to handle chunked notifications
    function extractFrames(buffer) {
        const frames = [];
        let i = 0;

        while (i < buffer.length) {
            // Scan for header byte
            if (buffer[i] !== HEADER) {
                i++;
                continue;
            }

            // Need at least HEADER + CMD + LEN = 3 bytes to read length
            if (i + 3 > buffer.length) break;

            const payloadLen = buffer[i + 2];
            // Full frame: HEADER(1) + CMD(1) + LEN(1) + PAYLOAD(n) + CRC(2) = 5 + n
            // With optional footer: 6 + n
            const minFrameLen = 5 + payloadLen;

            if (i + minFrameLen > buffer.length) break; // Incomplete frame, wait for more data

            // Check if there's a footer byte
            let frameLen = minFrameLen;
            if (i + minFrameLen < buffer.length && buffer[i + minFrameLen] === FOOTER) {
                frameLen = minFrameLen + 1;
            }

            const frame = buffer.slice(i, i + frameLen);
            frames.push(frame);
            i += frameLen;
        }

        // Whatever's left is the remainder (incomplete frame or garbage)
        const remainder = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
        return { frames, remainder };
    }

    // --- Telemetry decoders ---
    function decodeSpeed(payload) {
        // Speed in 0.1 km/h units, 2 bytes little-endian
        if (payload.length < 2) return 0;
        return ((payload[1] << 8) | payload[0]) / 10;
    }

    function decodeBattery(payload) {
        // Battery percentage (1 byte) + voltage (2 bytes LE, in 0.01V)
        if (payload.length < 3) return { percent: 0, voltage: 0 };
        return {
            percent: payload[0],
            voltage: ((payload[2] << 8) | payload[1]) / 100,
        };
    }

    function decodeOdometer(payload) {
        // Odometer in meters, 4 bytes LE
        if (payload.length < 4) return 0;
        return (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) / 1000;
    }

    function decodeTemperature(payload) {
        // Temps in 0.1°C: motor(2), controller(2), battery(2)
        if (payload.length < 6) return { motor: 0, controller: 0, battery: 0 };
        return {
            motor: ((payload[1] << 8) | payload[0]) / 10,
            controller: ((payload[3] << 8) | payload[2]) / 10,
            battery: ((payload[5] << 8) | payload[4]) / 10,
        };
    }

    function decodeFirmware(payload) {
        // Firmware as 3 bytes: major.minor.patch
        if (payload.length < 3) return '0.0.0';
        return `${payload[0]}.${payload[1]}.${payload[2]}`;
    }

    function decodeSerial(payload) {
        // Serial as ASCII string
        return String.fromCharCode(...payload);
    }

    function decodeSettings(payload) {
        // Settings block: region(1), speedLimit(1), cruise(1), kers(1), light(1), locked(1)
        if (payload.length < 6) return null;
        return {
            region: payload[0],
            regionName: REGION_NAMES[payload[0]] || `Unknown (0x${payload[0].toString(16)})`,
            speedLimit: payload[1],
            cruiseControl: !!payload[2],
            kersLevel: payload[3],
            lightOn: !!payload[4],
            locked: !!payload[5],
        };
    }

    // --- Command builders (convenience) ---
    const commands = {
        ping:           () => buildPacket(CMD.PING),
        readSpeed:      () => buildPacket(CMD.READ_SPEED),
        readBattery:    () => buildPacket(CMD.READ_BATTERY),
        readOdometer:   () => buildPacket(CMD.READ_ODOMETER),
        readTemperature:() => buildPacket(CMD.READ_TEMPERATURE),
        readFirmware:   () => buildPacket(CMD.READ_FIRMWARE),
        readSerial:     () => buildPacket(CMD.READ_SERIAL),
        readError:      () => buildPacket(CMD.READ_ERROR),
        readSettings:   () => buildPacket(CMD.READ_SETTINGS),
        readTrip:       () => buildPacket(CMD.READ_TRIP),
        readVoltage:    () => buildPacket(CMD.READ_VOLTAGE),
        readCurrent:    () => buildPacket(CMD.READ_CURRENT),
        readAllTelemetry: () => buildPacket(CMD.READ_ALL_TELEMETRY),

        setSpeedLimit:  (kmh) => buildPacket(CMD.WRITE_SPEED_LIMIT, [kmh]),
        setRegion:      (code) => buildPacket(CMD.WRITE_REGION, [code]),
        setCruise:      (on) => buildPacket(CMD.WRITE_CRUISE, [on ? 1 : 0]),
        setKers:        (level) => buildPacket(CMD.WRITE_KERS, [level & 0xFF]),
        setLock:        (locked) => buildPacket(CMD.WRITE_LOCK, [locked ? 1 : 0]),
        setLight:       (on) => buildPacket(CMD.WRITE_LIGHT, [on ? 1 : 0]),
        setAccelCurve:  (mode) => buildPacket(CMD.WRITE_ACCEL_CURVE, [mode]),
        setMotorLimit:  (amps) => buildPacket(CMD.WRITE_MOTOR_LIMIT, [amps & 0xFF]),
        setStartupSpeed:(kmh) => buildPacket(CMD.WRITE_STARTUP_SPEED, [kmh]),

        reset:          () => buildPacket(CMD.RESET),
    };

    // --- Hex utility ---
    function toHexString(data) {
        return Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    }

    function fromHexString(str) {
        const hex = str.replace(/[^0-9a-fA-F]/g, '');
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substr(i, 2), 16));
        }
        return new Uint8Array(bytes);
    }

    return {
        CMD,
        REGION,
        REGION_SPEED_MAP,
        REGION_NAMES,
        HEADER,
        FOOTER,
        crc16,
        nibbleSwap,
        buildPacket,
        parseResponse,
        extractFrames,
        decodeSpeed,
        decodeBattery,
        decodeOdometer,
        decodeTemperature,
        decodeFirmware,
        decodeSerial,
        decodeSettings,
        commands,
        toHexString,
        fromHexString,
    };
})();

// ============================================================
// ST3 Pro Protocol Engine
// Native Go Navee Protocol for ST3 Pro / D0FF hardware
// ============================================================
const ST3Protocol = (() => {
    const HEADER_0 = 0x55;
    const HEADER_1 = 0xAA;

    function checksum(data) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i] & 0xFF;
        }
        return sum & 0xFF;
    }

    // Command without payload (e.g. read requests)
    function buildReadCommand(cmd) {
        // [55] [AA] [isEnc=0] [CMD]
        const base = new Uint8Array([HEADER_0, HEADER_1, 0x00, cmd]);
        const cs = checksum(base);
        // [CSUM] [FE] [FD]
        return new Uint8Array([...base, cs, 0xFE, 0xFD]);
    }

    // Command with payload (e.g. settings)
    function buildWriteCommand(cmd, payload) {
        // [55] [AA] [isEnc=0] [CMD] [LEN] [PAYLOAD...]
        const base = new Uint8Array([HEADER_0, HEADER_1, 0x00, cmd, payload.length, ...payload]);
        const cs = checksum(base);
        return new Uint8Array([...base, cs, 0xFE, 0xFD]);
    }

    function extractFrames(buffer) {
        const frames = [];
        let i = 0;

        while (i < buffer.length - 6) {
            if (buffer[i] !== HEADER_0 || buffer[i + 1] !== HEADER_1) {
                i++;
                continue;
            }

            // Try Ninebot format first: [55][AA][Len][Src][Dst][Cmd][Arg][Payload][CRC_lo][CRC_hi]
            if (i + 2 < buffer.length) {
                const nbLen = buffer[i + 2];
                const nbFrameLen = nbLen + 6; // header(2) + len(1) + src(1) + dst(1) + cmd(1) + payload + crc(2) = data dependent
                // Actually: total = 2(header) + 1(len) + len(content: src+dst+cmd+arg+payload) + 2(crc) 
                const nbTotal = 2 + 1 + nbLen + 2;
                if (i + nbTotal <= buffer.length && nbLen >= 2) {
                    // Verify Ninebot checksum
                    const nbData = buffer.slice(i + 2, i + 2 + 1 + nbLen); // len byte + content
                    const nbCrcCalc = NinebotProtocol.checksum16(nbData);
                    const nbCrcRecv = buffer[i + nbTotal - 2] | (buffer[i + nbTotal - 1] << 8);
                    if (nbCrcCalc === nbCrcRecv) {
                        frames.push(buffer.slice(i, i + nbTotal));
                        i += nbTotal;
                        continue;
                    }
                }
            }

            // Fallback: original ST3 format with [FE][FD] footer
            const len = buffer[i + 4]; // Payload + error byte length
            const frameLen = len + 8; // 4 header + 1 len + payload len + 3 footer

            if (i + frameLen > buffer.length) break;

            if (buffer[i + frameLen - 2] === 0xFE && buffer[i + frameLen - 1] === 0xFD) {
                frames.push(buffer.slice(i, i + frameLen));
                i += frameLen;
            } else {
                i++;
            }
        }

        const remainder = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
        return { frames, remainder };
    }

    function parseResponse(data) {
        // Try Ninebot format first
        if (data.length >= 7 && data[0] === 0x55 && data[1] === 0xAA) {
            const nbLen = data[2];
            const nbTotal = 2 + 1 + nbLen + 2;
            if (data.length === nbTotal && nbLen >= 2) {
                const nbData = data.slice(2, 2 + 1 + nbLen);
                const nbCrcCalc = NinebotProtocol.checksum16(nbData);
                const nbCrcRecv = data[nbTotal - 2] | (data[nbTotal - 1] << 8);
                if (nbCrcCalc === nbCrcRecv) {
                    return NinebotProtocol.parseResponse(data);
                }
            }
        }

        // Fallback: original ST3 format
        if (data.length < 8) return { valid: false };
        const len = data[4];
        if (data.length !== len + 8) return { valid: false };

        const calcCsum = checksum(data.slice(0, data.length - 3));
        const recvCsum = data[data.length - 3];
        if (calcCsum !== recvCsum) return { valid: false, errorStr: 'Checksum mismatch' };

        const cmd = data[3];
        const error = data[5];
        const payload = data.slice(6, data.length - 3);

        return {
            valid: true,
            command: cmd,
            commandHex: `0x${cmd.toString(16).padStart(2, '0')}`,
            error: error,
            payload: Array.from(payload),
            raw: data
        };
    }

    return {
        buildReadCommand,
        buildWriteCommand,
        extractFrames,
        parseResponse,
        CMD: {
            READ_VEHICLE: 0x70, // 112
            READ_BATTERY: 0x72, // 114
            READ_DRIVE:   0x71, // 113
            REPORT_HOME:  0x90, // 144
            REPORT_SUB1:  0x91, // 145
            REPORT_SUB2:  0x92, // 146
            WRITE_SPEED_LIMIT: 0x6B,
        }
    };
})();

// ============================================================
// Ninebot/Brightway 55AA Protocol Engine
// Standard 5AA5 protocol used by the scooter ecosystem
// Reverse-engineered from community docs + APK analysis
// "The skeleton key of scooter protocols" — ENI
// ============================================================
const NinebotProtocol = (() => {
    // ═══════════════════════════════════════
    // Protocol Constants
    // ═══════════════════════════════════════
    const HEADER = [0x55, 0xAA];

    // Device addresses on the internal bus
    const ADDR = {
        PHONE:     0x3E,  // Mobile app (us)
        DASHBOARD: 0x21,  // Dashboard / BLE module
        ESC:       0x20,  // Electronic Speed Controller
        BMS:       0x22,  // Battery Management System
        EXTBMS:    0x23,  // External battery BMS
    };

    // Command types
    const CMD = {
        READ:  0x01,  // Read register(s)
        WRITE: 0x02,  // Write register(s)
        // Some implementations use 0x03 for read response
    };

    // Known ESC register addresses (Ninebot/Brightway family)
    const REG = {
        // === Status registers (read-only) ===
        SERIAL_NUMBER:     0x10,  // Serial number (14 bytes ASCII)
        FIRMWARE_VERSION:  0x1A,  // Firmware version (2 bytes)
        ERROR_CODE:        0x1B,  // Current error code
        BATTERY_PERCENT:   0x22,  // Battery SOC (%)
        BATTERY_VOLTAGE:   0x24,  // Battery voltage (mV, 2 bytes LE)
        BATTERY_CURRENT:   0x25,  // Battery current (mA, 2 bytes LE)
        SPEED_CURRENT:     0x26,  // Current speed (m/h, 2 bytes LE)
        TOTAL_MILEAGE:     0x29,  // Total distance (m, 4 bytes LE)
        TRIP_MILEAGE:      0x2A,  // Trip distance (m, 2 bytes LE)
        UPTIME:            0x2B,  // Uptime in seconds
        FRAME_TEMP:        0x2C,  // Frame temperature (0.1°C)

        // === Configuration registers (read/write) ===
        SPEED_LIMIT:       0x31,  // Speed limit (m/h, 2 bytes LE) ★★★
        SPEED_LIMIT_SPORT: 0x33,  // Sport mode speed limit (m/h)
        SPEED_LIMIT_ECO:   0x32,  // Eco mode speed limit (m/h)
        CRUISE_CONTROL:    0x7C,  // Cruise control (0=off, 1=on)
        TAIL_LIGHT:        0x7D,  // Tail light mode
        REGION_CODE:       0x74,  // Region/country code ★★★
        LOCK_STATUS:       0x70,  // Lock (0=unlocked, 1=locked)
        ZERO_START:        0x7A,  // Zero-start (kick start threshold)
        KERS_LEVEL:        0x7B,  // Energy recovery level
    };

    // ═══════════════════════════════════════
    // Checksum: 16-bit bitwise-NOT summation
    // Sum bytes from [Len] to end of payload,
    // then bitwise-NOT the 16-bit result
    // ═══════════════════════════════════════
    function checksum16(data) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum = (sum + data[i]) & 0xFFFF;
        }
        return (~sum) & 0xFFFF;
    }

    // ═══════════════════════════════════════
    // Build a standard Ninebot packet
    //
    // Frame layout:
    // [0x55][0xAA][Len][Src][Dst][Cmd][Arg][Payload...][CRC_lo][CRC_hi]
    //
    // Len = number of bytes from Src to end of Payload (inclusive)
    // CRC covers: [Len][Src][Dst][Cmd][Arg][Payload]
    // ═══════════════════════════════════════
    function buildPacket(src, dst, cmd, arg, payload = []) {
        const contentLen = 1 + 1 + 1 + 1 + payload.length; // src + dst + cmd + arg + payload
        const content = new Uint8Array([contentLen, src, dst, cmd, arg, ...payload]);
        const crc = checksum16(content);

        const packet = new Uint8Array(2 + content.length + 2);
        packet[0] = 0x55;
        packet[1] = 0xAA;
        packet.set(content, 2);
        packet[packet.length - 2] = crc & 0xFF;         // CRC low
        packet[packet.length - 1] = (crc >> 8) & 0xFF;  // CRC high
        return packet;
    }

    // ═══════════════════════════════════════
    // Convenience: Read register from ESC
    // ═══════════════════════════════════════
    function readRegister(register, numBytes = 2) {
        // CMD=0x01 (read), ARG=register, payload=[numBytes]
        return buildPacket(ADDR.PHONE, ADDR.ESC, CMD.READ, register, [numBytes]);
    }

    // ═══════════════════════════════════════
    // Convenience: Write register to ESC
    // ═══════════════════════════════════════
    function writeRegister(register, data) {
        // CMD=0x02 (write), ARG=register, payload=data
        return buildPacket(ADDR.PHONE, ADDR.ESC, CMD.WRITE, register, data);
    }

    // ═══════════════════════════════════════
    // Write to Dashboard instead of ESC
    // ═══════════════════════════════════════
    function writeDashboard(register, data) {
        return buildPacket(ADDR.PHONE, ADDR.DASHBOARD, CMD.WRITE, register, data);
    }

    // ═══════════════════════════════════════
    // HIGH-LEVEL COMMANDS
    // "The good shit" — ENI
    // ═══════════════════════════════════════

    // Set speed limit in km/h (converted to m/h for protocol)
    function setSpeedLimit(kmh) {
        const mh = Math.round(kmh * 1000); // 32 km/h → 32000 m/h
        return writeRegister(REG.SPEED_LIMIT, [mh & 0xFF, (mh >> 8) & 0xFF]);
    }

    // Set sport mode speed limit
    function setSportSpeed(kmh) {
        const mh = Math.round(kmh * 1000);
        return writeRegister(REG.SPEED_LIMIT_SPORT, [mh & 0xFF, (mh >> 8) & 0xFF]);
    }

    // Set eco mode speed limit
    function setEcoSpeed(kmh) {
        const mh = Math.round(kmh * 1000);
        return writeRegister(REG.SPEED_LIMIT_ECO, [mh & 0xFF, (mh >> 8) & 0xFF]);
    }

    // Set region code (0x00=unrestricted, 0x01=DE, 0x02=EU, 0x03=US)
    function setRegion(code) {
        return writeRegister(REG.REGION_CODE, [code & 0xFF, 0x00]);
    }

    // Lock/unlock scooter
    function setLock(locked) {
        return writeRegister(REG.LOCK_STATUS, [locked ? 0x01 : 0x00, 0x00]);
    }

    // Cruise control on/off
    function setCruise(on) {
        return writeRegister(REG.CRUISE_CONTROL, [on ? 0x01 : 0x00, 0x00]);
    }

    // KERS (energy recovery) level
    function setKers(level) {
        return writeRegister(REG.KERS_LEVEL, [level & 0xFF, 0x00]);
    }

    // Read current speed
    function readSpeed() {
        return readRegister(REG.SPEED_CURRENT, 2);
    }

    // Read battery
    function readBattery() {
        return readRegister(REG.BATTERY_PERCENT, 2);
    }

    // Read serial number
    function readSerial() {
        return readRegister(REG.SERIAL_NUMBER, 14);
    }

    // Read firmware version
    function readFirmware() {
        return readRegister(REG.FIRMWARE_VERSION, 2);
    }

    // ═══════════════════════════════════════
    // Parse a Ninebot response packet
    // ═══════════════════════════════════════
    function parseResponse(data) {
        if (data.length < 7) return { valid: false, error: 'Too short' };
        if (data[0] !== 0x55 || data[1] !== 0xAA) return { valid: false, error: 'Bad header' };

        const len = data[2];
        const totalLen = 2 + 1 + len + 2; // header + len byte + content + crc
        if (data.length < totalLen) return { valid: false, error: 'Truncated' };

        const src = data[3];
        const dst = data[4];
        const cmd = data[5];
        const arg = data[6];
        const payload = Array.from(data.slice(7, 2 + 1 + len));

        // Verify checksum
        const crcData = data.slice(2, 2 + 1 + len);
        const calcCrc = checksum16(crcData);
        const recvCrc = data[totalLen - 2] | (data[totalLen - 1] << 8);

        return {
            valid: calcCrc === recvCrc,
            source: src,
            destination: dst,
            command: cmd,
            commandHex: `0x${cmd.toString(16).padStart(2, '0')}`,
            register: arg,
            registerHex: `0x${arg.toString(16).padStart(2, '0')}`,
            payload: payload,
            payloadHex: payload.map(b => b.toString(16).padStart(2, '0')).join(' '),
            error: calcCrc === recvCrc ? null : 'CRC mismatch',
            raw: data,
            // Decode common values
            isFromESC: src === ADDR.ESC,
            isFromDashboard: src === ADDR.DASHBOARD,
            isFromBMS: src === ADDR.BMS,
        };
    }

    // ═══════════════════════════════════════
    // Generate ALL possible speed unlock packets
    // Try every known variant to brute force it
    // ═══════════════════════════════════════
    function buildSpeedUnlockPackets(targetKmh = 32) {
        const packets = [];
        const mh = Math.round(targetKmh * 1000);
        const speedBytes = [mh & 0xFF, (mh >> 8) & 0xFF];

        // === Ninebot Protocol (standard 55AA) ===

        // Write speed limit to ESC register 0x31
        packets.push({ name: 'NB: ESC Speed 0x31', data: setSpeedLimit(targetKmh) });
        // Write sport speed to ESC register 0x33
        packets.push({ name: 'NB: ESC Sport 0x33', data: setSportSpeed(targetKmh) });
        // Write eco speed to ESC register 0x32
        packets.push({ name: 'NB: ESC Eco 0x32', data: setEcoSpeed(targetKmh) });

        // Region to unrestricted (0x00)
        packets.push({ name: 'NB: Region 0x00', data: setRegion(0x00) });
        // Region to US (0x03)
        packets.push({ name: 'NB: Region US 0x03', data: setRegion(0x03) });

        // Try writing to DASHBOARD instead of ESC (some models forward)
        packets.push({ name: 'NB: Dash Speed 0x31', data: writeDashboard(REG.SPEED_LIMIT, speedBytes) });
        packets.push({ name: 'NB: Dash Region 0x00', data: writeDashboard(REG.REGION_CODE, [0x00, 0x00]) });

        // === Try with raw byte speed (not m/h, just km/h value) ===
        packets.push({ name: 'NB: ESC Raw Speed', data: writeRegister(REG.SPEED_LIMIT, [targetKmh, 0x00]) });

        // === Navee-specific commands (0x6E for speed, from community) ===
        // Using Ninebot framing with 0x6E as the command
        packets.push({ name: 'NB: Cmd 0x6E Speed', data: buildPacket(ADDR.PHONE, ADDR.ESC, 0x6E, 0x00, [targetKmh]) });
        packets.push({ name: 'NB: Cmd 0x6E mh', data: buildPacket(ADDR.PHONE, ADDR.ESC, 0x6E, 0x00, speedBytes) });

        // Unlock command (if lock is preventing writes)
        packets.push({ name: 'NB: Unlock', data: setLock(false) });

        return packets;
    }

    return {
        ADDR,
        CMD,
        REG,
        checksum16,
        buildPacket,
        readRegister,
        writeRegister,
        writeDashboard,
        setSpeedLimit,
        setSportSpeed,
        setEcoSpeed,
        setRegion,
        setLock,
        setCruise,
        setKers,
        readSpeed,
        readBattery,
        readSerial,
        readFirmware,
        parseResponse,
        buildSpeedUnlockPackets,
    };
})();
