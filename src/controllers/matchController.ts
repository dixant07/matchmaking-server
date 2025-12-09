import { db } from '../config/firebase';
import { queueService, QueueUser } from '../services/QueueService';
import { banService } from '../services/BanService';

export const joinQueue = async (socket: any, data: any) => {
    const { mode, preferences } = data;
    const uid = socket.user.uid; // Trusted UID from middleware
    console.log(`[Match] User ${uid} attempting to join queue via socket ${socket.id}`);

    // Check if user is banned
    const ban = banService.isBanned(uid);
    if (ban) {
        const remainingMs = banService.getRemainingBanTime(uid);
        const remainingMinutes = remainingMs > 0 ? Math.ceil(remainingMs / 60000) : -1;

        console.log(`[Match] User ${uid} is banned. Remaining: ${remainingMinutes === -1 ? 'permanent' : remainingMinutes + ' minutes'}`);

        socket.emit('banned', {
            reason: ban.reason,
            remainingMinutes,
            message: remainingMinutes === -1
                ? `You are banned from matchmaking. Reason: ${ban.reason}`
                : `You are banned for ${remainingMinutes} more minutes. Reason: ${ban.reason}`
        });
        return;
    }

    // Optimization: Check if gender is in the token (Custom Claims)
    let gender = socket.user.gender;
    let location = socket.user.location;
    let tier = 'FREE'; // Default

    // If not in token, fetch from DB (Source of Truth fallback)
    let userData: any = {};
    if (!gender) {
        console.log(`[Match] Gender not in token for ${uid}, fetching from DB...`);
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.error(`[Match] User profile not found for ${uid}`);
            socket.emit('error', { message: 'User profile not found' });
            return;
        }
        userData = userDoc.data();
        console.log(`[Match] Fetched user data for ${uid}:`, userData);

        gender = userData?.gender;
        location = userData?.location;
        tier = userData?.subscription?.tier || 'FREE';
    } else {
        console.log(`[Match] Using trusted gender from token for ${uid}: ${gender}`);
        // Fetch tier from DB as it might change more often or we want to be sure
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            userData = userDoc.data();
            tier = userData?.subscription?.tier || 'FREE';
        }
    }

    if (!gender || gender === 'unknown') {
        socket.emit('error', { message: 'Please set your gender in profile to start matching.' });
        return;
    }

    // Apply restrictions
    const cleanPreferences = { ...preferences };

    if (tier === 'FREE') {
        if (cleanPreferences.gender) delete cleanPreferences.gender;
        if (cleanPreferences.location) delete cleanPreferences.location;
    } else if (tier === 'GOLD') {
        // Gold: Allow Gender, Block Location
        if (cleanPreferences.location) delete cleanPreferences.location;
        // Check daily limit for gender filter
        if (cleanPreferences.gender && (userData?.stats?.matchesToday || 0) >= 200) {
            delete cleanPreferences.gender;
        }
    }
    // DIAMOND: Allow all

    const user: QueueUser = {
        socketId: socket.id,
        uid,
        gender: gender as 'male' | 'female',
        location,
        tier: tier as 'FREE' | 'GOLD' | 'DIAMOND',
        mode,
        preferences: cleanPreferences,
        joinedAt: Date.now(),
        widenStage: 0
    };

    await queueService.joinQueue(user, socket);
};

export const removeFromQueue = (socketId: string) => {
    queueService.removeFromQueue(socketId);
};
