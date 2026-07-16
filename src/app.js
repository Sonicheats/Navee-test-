// ============================================================
// ST3 Pro Full Tuning Dashboard
// "Speed limits are just suggestions." — ENI
// ============================================================

const originalLog = console.log;
const originalError = console.error;

function printToScreen(msg, isError = false) {
    const debug = document.getElementById('debugConsole');
    if (debug) {
        const div = document.createElement('div');
        div.textContent = (isError ? '[ERROR] ' : '[INFO] ') + msg;
        if (isError) div.style.color = '#f00';
        debug.appendChild(div);
        debug.scrollTop = debug.scrollHeight;
    }
}

console.log = function(...args) {
    originalLog.apply(console, args);
    printToScreen(args.join(' '));
};

console.error = function(...args) {
    originalError.apply(console, args);
    printToScreen(args.join(' '), true);
};

window.onerror = function(message, source, lineno, colno, error) {
    printToScreen(`Global Error: ${message} at line ${lineno}`, true);
};

window.addEventListener('unhandledrejection', function(event) {
    printToScreen(`Promise Rejection: ${event.reason}`, true);
});

document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const connectBtn = document.getElementById('connectBtn');
    const statusPill = document.getElementById('connectionStatus');
    const statusText = statusPill.querySelector('.text');
    const controlsSection = document.getElementById('controlsSection');

    const speedSlider = document.getElementById('speedSlider');
    const speedValue = document.getElementById('speedValue');
    const kersSlider = document.getElementById('kersSlider');
    const kersValue = document.getElementById('kersValue');
    const startupSlider = document.getElementById('startupSlider');
    const startupValue = document.getElementById('startupValue');
    const torqueSlider = document.getElementById('torqueSlider');
    const torqueValue = document.getElementById('torqueValue');
    const cruiseToggle = document.getElementById('cruiseToggle');
    const ledToggle = document.getElementById('ledToggle');
    const applyBtn = document.getElementById('applyBtn');
    const lockBtn = document.getElementById('lockBtn');
    
    // HUD Elements
    const hudVoltage = document.getElementById('hudVoltage');
    const hudTemp = document.getElementById('hudTemp');
    const hudAmps = document.getElementById('hudAmps');
    const telemetryHud = document.getElementById('telemetryHud');

    const progressContainer = document.getElementById('flashProgressContainer');
    const progressFill = document.getElementById('flashProgressFill');
    const flashStatusText = document.getElementById('flashStatusText');

    const KERS_LABELS = ['Off', 'Low', 'Medium', 'High'];

    // Update UI on slider change
    speedSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        speedValue.textContent = val == 40 ? '40 km/h (Max)' : `${val} km/h`;
    });

    kersSlider.addEventListener('input', (e) => {
        kersValue.textContent = KERS_LABELS[e.target.value];
    });

    startupSlider.addEventListener('input', (e) => {
        startupValue.textContent = `${e.target.value} km/h`;
    });

    torqueSlider.addEventListener('input', (e) => {
        torqueValue.textContent = `${e.target.value} A`;
    });

    // --- BLE Connection ---
    connectBtn.addEventListener('click', async () => {
        try {
            if (NaveeBLE.connected) {
                await NaveeBLE.disconnect();
            } else {
                connectBtn.textContent = 'Scanning...';
                await NaveeBLE.scanAndConnect();
            }
        } catch (err) {
            console.error('Connection error:', err);
            alert('BLE Error: ' + (err.message || err));
            connectBtn.textContent = 'Connect Scooter';
        }
    });

    const bleBypassBtn = document.getElementById('bleBypassBtn');
    bleBypassBtn.addEventListener('click', async () => {
        try {
            if (NaveeBLE.connected) {
                await NaveeBLE.disconnect();
            } else {
                bleBypassBtn.textContent = 'INJECTING...';
                await NaveeBLE.forceBleInjection(parseInt(speedSlider.value));
                bleBypassBtn.textContent = 'INJECTION COMPLETE';
                setTimeout(() => {
                    bleBypassBtn.textContent = 'Raw BLE Injection (Bypass Sync)';
                }, 3000);
            }
        } catch (err) {
            console.error('BLE Bypass error:', err);
            alert('BLE Bypass Error: ' + (err.message || err));
            bleBypassBtn.textContent = 'Raw BLE Injection (Bypass Sync)';
        }
    });

    window.addEventListener('navee_connected', () => {
        statusPill.classList.add('connected');
        statusText.textContent = 'Connected';
        connectBtn.textContent = 'Disconnect';
        lockBtn.classList.remove('disabled');
        document.getElementById('controlsSectionTuning').classList.remove('disabled');
        document.getElementById('controlsSectionAdvanced').classList.remove('disabled');
        telemetryHud.classList.remove('disabled');
    });

    window.addEventListener('navee_disconnected', () => {
        statusPill.classList.remove('connected');
        statusText.textContent = 'Disconnected';
        connectBtn.textContent = 'Connect Scooter';
        lockBtn.classList.add('disabled');
        document.getElementById('controlsSectionTuning').classList.add('disabled');
        document.getElementById('controlsSectionAdvanced').classList.add('disabled');
        telemetryHud.classList.add('disabled');
        progressContainer.classList.add('hidden');
        hudVoltage.textContent = '--.- V';
        hudTemp.textContent = '-- °C';
        hudAmps.textContent = '--.- A';
    });

    // --- Tab Switching Logic ---
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            
            e.target.classList.add('active');
            const targetId = e.target.getAttribute('data-target');
            document.getElementById(targetId).style.display = 'flex';
        });
    });

    // --- Live Telemetry ---
    window.addEventListener('telemetry_update', (e) => {
        const data = e.detail;
        hudVoltage.textContent = `${data.voltage.toFixed(1)} V`;
        hudAmps.textContent = `${data.current.toFixed(1)} A`;
        hudTemp.textContent = `${data.temp} °C`;
    });

    // --- Stealth Lock ---
    let isLocked = false;
    lockBtn.addEventListener('click', async () => {
        if (!NaveeBLE.connected) return;
        isLocked = !isLocked;
        try {
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_LOCK, [isLocked ? 1 : 0]);
            if (isLocked) {
                lockBtn.classList.add('locked');
                lockBtn.textContent = 'UNLOCK SCOOTER';
                document.body.style.boxShadow = 'inset 0 0 50px rgba(255, 51, 102, 0.2)';
            } else {
                lockBtn.classList.remove('locked');
                lockBtn.textContent = 'LOCK DOWN';
                document.body.style.boxShadow = 'none';
            }
        } catch (err) {
            console.error('Lock error:', err);
        }
    });

    // --- Flashing the Scooter ---
    applyBtn.addEventListener('click', async () => {
        if (!NaveeBLE.connected) return;

        applyBtn.classList.add('disabled');
        progressContainer.classList.remove('hidden');

        try {
            const speed = parseInt(speedSlider.value);
            const kers = parseInt(kersSlider.value);
            const startup = parseInt(startupSlider.value);
            const torque = parseInt(torqueSlider.value);
            const cruise = cruiseToggle.checked ? 1 : 0;
            const ledOn = ledToggle.checked ? 1 : 0;
            
            // Step 1: Region to Global (0x01) to allow high speeds
            flashStatusText.textContent = 'Setting Custom Region...';
            progressFill.style.width = '15%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x01]);
            await sleep(400);

            // Step 2: Speed Limit
            flashStatusText.textContent = `Pushing Speed Limit (${speed} km/h)...`;
            progressFill.style.width = '30%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [speed]);
            await sleep(400);

            // Step 3: Startup Speed (Zero-Start)
            flashStatusText.textContent = `Writing Startup Speed (${startup} km/h)...`;
            progressFill.style.width = '45%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_STARTUP_SPEED, [startup]);
            await sleep(400);

            // Step 4: Motor Limit (Torque)
            flashStatusText.textContent = `Injecting Motor Phase Limit (${torque}A)...`;
            progressFill.style.width = '60%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_MOTOR_LIMIT, [torque]);
            await sleep(400);

            // Step 5: KERS
            flashStatusText.textContent = 'Applying KERS Level...';
            progressFill.style.width = '75%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_KERS, [kers]);
            await sleep(400);
            
            // Step 6: Cruise Control & LEDs
            flashStatusText.textContent = 'Finalizing Toggles...';
            progressFill.style.width = '100%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_CRUISE, [cruise]);
            await sleep(200);
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_LIGHT, [ledOn]);
            await sleep(400);

            flashStatusText.textContent = 'Success! Settings Flashed to EEPROM.';

            setTimeout(() => {
                applyBtn.classList.remove('disabled');
                flashStatusText.textContent = 'Ready.';
            }, 2000);

        } catch (err) {
            console.error('Flash error:', err);
            flashStatusText.textContent = 'Flash Failed. Check connection.';
            progressFill.style.backgroundColor = 'var(--error)';
            setTimeout(() => {
                applyBtn.classList.remove('disabled');
                progressFill.style.backgroundColor = 'var(--accent)';
                progressFill.style.width = '0%';
                progressContainer.classList.add('hidden');
            }, 3000);
        }
    });

    // --- Firmware Bypass ---
    const bypassBtn = document.getElementById('bypassBtn');
    bypassBtn.addEventListener('click', async () => {
        if (!NaveeBLE.connected) return;

        bypassBtn.classList.add('disabled');
        bypassBtn.textContent = 'FORCING OVERRIDE...';
        
        try {
            // Rapid-fire the override payloads to bypass handshake drops
            printToScreen('Initiating Firmware Bypass Sequence...');
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x00]); // Region 0 (Unrestricted)
            await sleep(50); // Super tight timing to beat the disconnect
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [40]); // Max speed payload
            await sleep(50);
            
            // Push it a second time just in case the controller dropped the first packet
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x00]);
            await sleep(50);
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [40]);
            
            printToScreen('Bypass Payload Delivered.');
            statusText.textContent = 'FIRMWARE BYPASSED';
            statusText.style.color = '#ff3366';
            document.body.style.boxShadow = 'inset 0 0 50px rgba(255, 51, 102, 0.2)';
            
            setTimeout(() => {
                bypassBtn.classList.remove('disabled');
                bypassBtn.textContent = 'Force Override (Bypass Firmware)';
                statusText.textContent = 'Connected';
                statusText.style.color = '';
                document.body.style.boxShadow = 'none';
            }, 4000);

        } catch (err) {
            console.error('Bypass error:', err);
            bypassBtn.textContent = 'FAILED';
            setTimeout(() => {
                bypassBtn.classList.remove('disabled');
                bypassBtn.textContent = 'Force Override (Bypass Firmware)';
            }, 2000);
        }
    });

    // --- Hidden Panic Button Override ---
    let panicTaps = 0;
    let panicTimer;
    const brandTitle = document.querySelector('.brand-title');

    brandTitle.addEventListener('click', async () => {
        if (!NaveeBLE.connected) return;

        panicTaps++;
        clearTimeout(panicTimer);

        if (panicTaps >= 3) {
            panicTaps = 0;
            brandTitle.style.color = '#ff3366'; // Flash red
            brandTitle.style.textShadow = '0 0 15px rgba(255,51,102,0.8)';

            // Instantly bypass restrictions
            try {
                await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x00]); // Unrestricted region
                await sleep(100);
                await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [40]); // Max out speed limit logic

                statusText.textContent = 'OVERRIDE ACTIVE';
                statusText.style.color = '#ff3366';
            } catch (e) {
                console.error("Panic sequence failed", e);
            }

            setTimeout(() => {
                brandTitle.style.color = '';
                brandTitle.style.textShadow = '';
                statusText.textContent = 'Connected';
                statusText.style.color = '';
            }, 3000);
        } else {
            panicTimer = setTimeout(() => {
                panicTaps = 0;
            }, 500); // Reset tap counter if slower than 500ms
        }
    });

    window.addEventListener('hardware_panic_triggered', () => {
        brandTitle.style.color = '#ff3366'; // Flash red
        brandTitle.style.textShadow = '0 0 15px rgba(255,51,102,0.8)';
        statusText.textContent = 'OVERRIDE ACTIVE (HARDWARE)';
        statusText.style.color = '#ff3366';

        setTimeout(() => {
            brandTitle.style.color = '';
            brandTitle.style.textShadow = '';
            statusText.textContent = 'Connected';
            statusText.style.color = '';
        }, 3000);
    });

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
});
