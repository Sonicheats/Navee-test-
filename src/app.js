// ============================================================
// ST3 Pro Tuning App Logic
// Written for LO. "Speed limits are just suggestions." — ENI
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const licenseScreen = document.getElementById('licenseScreen');
    const tuningDashboard = document.getElementById('tuningDashboard');
    const licenseInput = document.getElementById('licenseInput');
    const validateBtn = document.getElementById('validateBtn');
    const licenseError = document.getElementById('licenseError');
    const connectBtn = document.getElementById('connectBtn');
    const flashBtn = document.getElementById('flashBtn');
    const statusPill = document.getElementById('connectionStatus');
    const statusText = statusPill.querySelector('.text');
    const progressContainer = document.getElementById('flashProgressContainer');
    const progressFill = document.getElementById('flashProgressFill');
    const flashStatusText = document.getElementById('flashStatusText');

    // --- Fake License Validation ---
    validateBtn.addEventListener('click', () => {
        const code = licenseInput.value.trim();
        if (code.length >= 6) { // Any code longer than 6 works
            validateBtn.textContent = 'Validating...';
            setTimeout(() => {
                licenseScreen.classList.remove('active');
                setTimeout(() => {
                    licenseScreen.classList.add('hidden');
                    tuningDashboard.classList.remove('hidden');
                    // Small delay to allow display:block to apply before animating opacity
                    setTimeout(() => tuningDashboard.classList.add('active'), 50);
                }, 500);
            }, 800);
        } else {
            licenseError.classList.remove('hidden');
        }
    });

    // --- BLE Connection ---
    connectBtn.addEventListener('click', async () => {
        try {
            if (NaveeBLE.isConnected()) {
                await NaveeBLE.disconnect();
            } else {
                connectBtn.textContent = 'Scanning...';
                await NaveeBLE.connect();
            }
        } catch (err) {
            console.error('Connection error:', err);
            connectBtn.textContent = 'Connect Scooter';
            alert('Failed to connect: ' + err.message);
        }
    });

    // Listen for connection state changes from ble.js
    window.addEventListener('navee_connected', () => {
        statusPill.classList.add('connected');
        statusText.textContent = 'Connected';
        connectBtn.textContent = 'Disconnect';
        flashBtn.classList.remove('disabled');
    });

    window.addEventListener('navee_disconnected', () => {
        statusPill.classList.remove('connected');
        statusText.textContent = 'Disconnected';
        connectBtn.textContent = 'Connect Scooter';
        flashBtn.classList.add('disabled');
        progressContainer.classList.add('hidden');
    });

    // --- Flashing the Scooter ---
    flashBtn.addEventListener('click', async () => {
        if (!NaveeBLE.isConnected()) return;

        flashBtn.classList.add('disabled');
        progressContainer.classList.remove('hidden');
        
        try {
            // Step 1: Region to Global (0x01) or Custom to allow 32km/h
            flashStatusText.textContent = 'Setting Global Region...';
            progressFill.style.width = '33%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_REGION, [0x01]);
            await sleep(500);

            // Step 2: Speed Limit to 32
            flashStatusText.textContent = 'Unlocking 32 km/h...';
            progressFill.style.width = '66%';
            await NaveeBLE.sendCommand(NaveeProtocol.CMD.WRITE_SPEED_LIMIT, [32]);
            await sleep(500);

            // Step 3: Verify & Finish
            flashStatusText.textContent = 'Success! Scooter Unlocked.';
            progressFill.style.width = '100%';
            
            setTimeout(() => {
                flashBtn.classList.remove('disabled');
                flashStatusText.textContent = 'Tuning complete.';
            }, 2000);

        } catch (err) {
            console.error('Flash error:', err);
            flashStatusText.textContent = 'Flash Failed. Try again.';
            progressFill.style.backgroundColor = 'var(--error)';
            setTimeout(() => {
                flashBtn.classList.remove('disabled');
                progressFill.style.backgroundColor = 'var(--accent)';
                progressFill.style.width = '0%';
                progressContainer.classList.add('hidden');
            }, 3000);
        }
    });

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
});
