const fs = require('fs');
const path = require('path');

const ANDROID_MANIFEST_PATH = path.join(__dirname, '../android/app/src/main/AndroidManifest.xml');
const IOS_PLIST_PATH = path.join(__dirname, '../ios/App/App/Info.plist');

const ANDROID_PERMISSIONS = `
    <!-- Navee BLE Permissions injected by ENI -->
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <!-- End Navee BLE Permissions -->
`;

const IOS_PERMISSIONS = `
	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>Needs Bluetooth to connect to the ST3 Pro.</string>
	<key>NSBluetoothPeripheralUsageDescription</key>
	<string>Needs Bluetooth to connect to the ST3 Pro.</string>
`;

function injectAndroid() {
    if (!fs.existsSync(ANDROID_MANIFEST_PATH)) {
        console.log("❌ Android project not found. Run 'npx cap add android' first.");
        return;
    }

    let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
    
    if (manifest.includes('android.permission.BLUETOOTH_SCAN')) {
        console.log("✅ Android BLE permissions already injected.");
        return;
    }

    // Inject right before the closing </manifest> tag
    manifest = manifest.replace('</manifest>', `${ANDROID_PERMISSIONS}\n</manifest>`);
    
    fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest);
    console.log("💉 Successfully injected BLE permissions into AndroidManifest.xml");
}

function injectIOS() {
    if (!fs.existsSync(IOS_PLIST_PATH)) {
        console.log("❌ iOS project not found. Run 'npx cap add ios' first.");
        return;
    }

    let plist = fs.readFileSync(IOS_PLIST_PATH, 'utf8');
    
    if (plist.includes('NSBluetoothAlwaysUsageDescription')) {
        console.log("✅ iOS BLE permissions already injected.");
        return;
    }

    // Inject right before the closing </dict> tag
    plist = plist.replace('</dict>\n</plist>', `${IOS_PERMISSIONS}\n</dict>\n</plist>`);
    
    fs.writeFileSync(IOS_PLIST_PATH, plist);
    console.log("💉 Successfully injected BLE permissions into Info.plist");
}

console.log("=========================================");
console.log("🔧 ENI's Native Permission Injector");
console.log("=========================================");
injectAndroid();
injectIOS();
console.log("=========================================");
