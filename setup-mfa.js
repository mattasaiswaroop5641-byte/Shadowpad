const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const secret = speakeasy.generateSecret({
    name: "ShadowPad Admin"
});

console.log("Your Secret Key (SAVE THIS PRIVATELY):", secret.base32);

// This generates a QR code you can scan with Google Authenticator
qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
    console.log("Scan this QR Code in your Authenticator App:");
    console.log(data_url); // Copy this long string into a browser to see the QR
});