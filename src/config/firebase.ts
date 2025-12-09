import admin from 'firebase-admin';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

if (!admin.apps.length) {
    let credential;
    let credentialSource = '';

    // Priority 1: Try to load from base64-encoded environment variable
    const base64ServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (base64ServiceAccountKey) {
        try {
            console.log('[Firebase] Attempting to decode FIREBASE_SERVICE_ACCOUNT_KEY from base64...');
            const decodedKey = Buffer.from(base64ServiceAccountKey, 'base64').toString('utf-8');
            const serviceAccount = JSON.parse(decodedKey);
            credential = admin.credential.cert(serviceAccount);
            credentialSource = 'FIREBASE_SERVICE_ACCOUNT_KEY (base64 env var)';
            console.log('[Firebase] Successfully loaded credentials from base64 environment variable');
        } catch (error) {
            console.error('[Firebase] Failed to decode/parse FIREBASE_SERVICE_ACCOUNT_KEY:', error);
            console.log('[Firebase] Falling back to file-based credentials...');
        }
    }

    // Priority 2: Try to load service account key from file
    if (!credential) {
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            path.join(__dirname, '../../oreo-video-app-v1-firebase-adminsdk-fbsvc-751f63dcd0.json');

        if (fs.existsSync(serviceAccountPath)) {
            console.log(`[Firebase] Loading credentials from file: ${serviceAccountPath}`);
            const serviceAccount = require(serviceAccountPath);
            credential = admin.credential.cert(serviceAccount);
            credentialSource = `File: ${serviceAccountPath}`;
        } else {
            console.log('[Firebase] No service account key file found.');
            console.log(`[Firebase] Checked path: ${serviceAccountPath}`);
        }
    }

    // Priority 3: Try application default credentials
    if (!credential) {
        console.log('[Firebase] Attempting to use application default credentials...');
        try {
            credential = admin.credential.applicationDefault();
            credentialSource = 'Application Default Credentials';
        } catch (error) {
            console.error('\n❌ FIREBASE INITIALIZATION FAILED ❌');
            console.error('Could not load Firebase credentials.');
            console.error('\nPlease do ONE of the following:');
            console.error('1. Set FIREBASE_SERVICE_ACCOUNT_KEY with base64-encoded service account JSON');
            console.error('2. Download service account key from Firebase Console and save it');
            console.error('3. Set GOOGLE_APPLICATION_CREDENTIALS environment variable');
            console.error('4. Run on Google Cloud Platform with default credentials\n');
            throw error;
        }
    }

    admin.initializeApp({
        credential: credential,
        projectId: process.env.FIREBASE_PROJECT_ID || 'oreo-video-app-v1'
    });

    console.log(`[Firebase] Credential source: ${credentialSource}`);
}

export const db = admin.firestore();
export const auth = admin.auth();

console.log('✅ Firebase Admin Initialized for Matchmaking Server');
console.log('[Firebase] Project ID:', admin.app().options.projectId);
