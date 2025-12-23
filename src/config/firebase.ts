import admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// Server-side Firebase Admin SDK initialization
// This file should only be imported in API routes (server-side)

// Variables replaced by lazy-loaded Proxies below

function initializeFirebaseAdmin() {
    if (admin.apps.length > 0) {
        return;
    }

    let credential;

    // Priority 1: Load from FIREBASE_SERVICE_ACCOUNT_KEY env var (Base64 encoded JSON)
    // This is the recommended approach for production deployments
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        try {
            console.log('[Firebase Admin] Loading credentials from FIREBASE_SERVICE_ACCOUNT_KEY env var');
            const serviceAccountJson = Buffer.from(
                process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
                'base64'
            ).toString('utf8');
            const serviceAccount = JSON.parse(serviceAccountJson);
            credential = admin.credential.cert(serviceAccount);
        } catch (error) {
            console.error('[Firebase Admin] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', error);
            throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_KEY - must be valid Base64 encoded JSON');
        }
    }

    if (admin.apps.length === 0) {
        if (credential) {
            try {
                const serviceAccount = credential as any;
                console.log('✅ Firebase Admin Initialized with Token Access');
                // Attempt to safely log the project ID if available in the credential object
                const credProjectId = serviceAccount?.projectId || serviceAccount?.project_id || 'unknown';
                console.log('🔑 Credential Project ID:', credProjectId);

                admin.initializeApp({
                    credential: credential,
                    projectId: credProjectId
                });
                console.log('✅ Firebase Admin Initialized Successfully');
                console.log('Project ID:', admin.app().options.projectId);
            } catch (e) {
                console.error('Error during admin.initializeApp:', e);
            }
        } else {
            // If no credentials (e.g. during build where secrets aren't available), 
            // skip initialization to prevent build crash.
            // If no credentials found, try Application Default Credentials (ADC)
            // This is required for Cloud Run / App Engine / Cloud Functions
            try {
                admin.initializeApp({
                    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'rumi-live',
                    credential: admin.credential.applicationDefault()
                });
                console.log('✅ Firebase Admin Initialized with ADC');
            } catch (e) {
                console.warn('[Firebase Admin] Skipping initialization: No credentials found (build step) and ADC failed.', e);
            }
        }
    }
}

// Initialize on first import
initializeFirebaseAdmin();

import { getFirestore } from 'firebase-admin/firestore';

const db = new Proxy({} as admin.firestore.Firestore, {
    get: (_target, prop) => {
        initializeFirebaseAdmin();
        if (!admin.apps.length) {
            throw new Error('Firebase Admin not initialized. Ensure FIREBASE_SERVICE_ACCOUNT_KEY is set.');
        }
        // Explicitly use named database "default" (no parens)
        // Standard admin.firestore() defaults to "(default)" which leads to 5 NOT_FOUND
        return Reflect.get(getFirestore(admin.app(), 'default'), prop);
    }
});

const auth = new Proxy({} as admin.auth.Auth, {
    get: (_target, prop) => {
        initializeFirebaseAdmin();
        if (!admin.apps.length) {
            throw new Error('Firebase Admin not initialized. Ensure FIREBASE_SERVICE_ACCOUNT_KEY is set.');
        }
        return Reflect.get(admin.auth(), prop);
    }
});

export { db, auth, admin };
