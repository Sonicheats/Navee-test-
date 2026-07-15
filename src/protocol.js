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
        }
    };
})();
