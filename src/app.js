// ============================================================
// ST3 Pro Full Tuning Dashboard
// "Speed limits are just suggestions." — ENI
// ============================================================

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
    const cruiseToggle = document.getElementById('cruiseToggle');
    const ledToggle = document.getElementById('ledToggle');
    const applyBtn = document.getElementById('applyBtn');
    
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
            connectBtn.textContent = 'Connect Scooter';
            alert('Failed to connect: ' + err.message);
        }
    });

    window.addEventListener('navee_connected', () => {
        statusPill.classList.add('connected');
        statusText.textContent = 'Connected';
        connectBtn.textContent = 'Disconnect';
        controlsSection.classList.remove('disabled');
    });

    window.addEventListener('navee_disconnected', () => {
        statusPill.classList.remove('connected');
        statusText.textContent = 'Disconnected';
        connectBtn.textContent = 'Connect Scooter';
        controlsSection.classList.add('disabled');
        progressContainer.classList.add('hidden');
    });

    // --- Flashing the Scooter ---
    applyBtn.addEventListener('click', async () => {
        if (!NaveeBLE.connected) return;

        applyBtn.classList.add('disabled');
        progressContainer.classList.remove('hidden');
        
        try {
            const speed = parseInt(speedSlider.value);
            const kers = parseInt(kersSlider.value);
            const cruise = cruiseToggle.checked ? 1 : 0;
            
            // Step 1: Region to Global (0x01) to allow high speeds
            flashStatusText.textContent = 'Setting Custom Region...';
            progressFill.style.width = '25%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x01]);
            await sleep(400);

            // Step 2: Speed Limit
            flashStatusText.textContent = `Pushing Speed Limit (${speed} km/h)...`;
            progressFill.style.width = '50%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [speed]);
            await sleep(400);

            // Step 3: KERS
            flashStatusText.textContent = 'Applying KERS Level...';
            progressFill.style.width = '75%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_KERS, [kers]);
            await sleep(400);
            
            // Step 4: Cruise Control
            flashStatusText.textContent = 'Writing Cruise Control...';
            progressFill.style.width = '85%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_CRUISE, [cruise]);
            await sleep(400);

            // Step 5: Side LEDs
            const ledOn = ledToggle.checked ? 1 : 0;
            flashStatusText.textContent = 'Setting LED State...';
            progressFill.style.width = '100%';
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
            } catch(e) {
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
