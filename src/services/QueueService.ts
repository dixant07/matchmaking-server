import { db } from '../config/firebase';
import * as admin from 'firebase-admin';
import { sessionService } from './SessionService';
import redisClient from '../config/redis';
import { Server } from 'socket.io';

export interface QueueUser {
    socketId: string;
    uid: string;
    name?: string; // Display name — crucial for guests (no Firestore profile)
    gender: 'male' | 'female';
    location?: string;
    tier: 'FREE' | 'GOLD' | 'DIAMOND';
    mode: 'random' | 'video';
    preferences: {
        gender?: 'male' | 'female';
        location?: string;
    };
    joinedAt: number;
    widenStage: 0 | 1 | 2; // Derived from time usually, but keeping for compatibility
    botModeActive?: boolean; // New flag to track if user is playing with bot while in queue
}

class QueueService {
    private readonly KEY_QUEUE_MALE = 'queue:male';
    private readonly KEY_QUEUE_FEMALE = 'queue:female';
    private readonly KEY_USER_DATA = 'queue:user:'; // + uid
    private readonly KEY_BOTS = 'queue:bots';
    private readonly LOCK_KEY = 'lock:matchmaking';
    private readonly LOCK_TTL = 3; // seconds

    constructor() { }

    public async registerBot(socketId: string, uid: string) {
        // Store bot info as JSON string in a Set
        const botData = JSON.stringify({ socketId, uid });
        await redisClient.sAdd(this.KEY_BOTS, botData);
        console.log(`[Queue] Bot registered: ${socketId} (UID: ${uid})`);
    }

    public async unregisterBot(socketId: string) {
        // Since we store JSON, removing specific socket requires scanning or just ignoring invalid ones later.
        // For distinct removal, we'd need a secondary index.
        // We'll trust ephemeral nature or SPOP for cleanup.
        // Real implementation would use Hash storage for bots.
    }

    public async joinQueue(user: QueueUser, socket: any) {
        // 1. Clean previous state if any
        await this.removeUserByUid(user.uid);

        // 2. Save user data
        await redisClient.set(`${this.KEY_USER_DATA}${user.uid}`, JSON.stringify(user));

        // 3. Add to ZSET (Score = JoinedAt)
        const queueKey = user.gender === 'male' ? this.KEY_QUEUE_MALE : this.KEY_QUEUE_FEMALE;
        await redisClient.zAdd(queueKey, { score: user.joinedAt, value: user.uid });

        console.log(`[Queue] User ${user.uid} joined ${user.gender} queue. Tier: ${user.tier}`);
    }

    public async removeFromQueue(socketId: string) {
        // Try to reverse lookup UID from Socket map if possible
        // We rely on sessionService for this
        // But sessionService might not have it if disconnected?
        // Actually sessionService stores socket:uid mapping
        const uid = await redisClient.get(`socket:uid:${socketId}`);
        if (uid) {
            await this.removeUserByUid(uid);
        }
    }

    public async removeUserByUid(uid: string) {
        await redisClient.zRem(this.KEY_QUEUE_MALE, uid);
        await redisClient.zRem(this.KEY_QUEUE_FEMALE, uid);
        await redisClient.del(`${this.KEY_USER_DATA}${uid}`);
    }

    // --- Distributed Matching Logic ---

    public async processMatches(io: Server) {
        // 1. Acquire Distributed Lock (Simple SET NX EX)
        const locked = await redisClient.set(this.LOCK_KEY, 'LOCKED', {
            NX: true,
            EX: this.LOCK_TTL
        });

        if (!locked) {
            // Lock busy, another pod is processing
            return;
        }

        try {
            await this.runMatchingCycle(io);
        } catch (e) {
            console.error('[Queue] Error in matching cycle:', e);
        } finally {
            // Release lock (safely? or just let TTL expire? TTL 3s is short)
            // If we delete, we might release lock held by next process if time drift?
            // With random value token we can check ownership.
            await redisClient.del(this.LOCK_KEY);
        }
    }

    private async runMatchingCycle(io: Server) {
        // 1. Fetch TOP 100 users from queues (Oldest first)
        // Adjust batch size based on performance
        const BATCH_SIZE = 100;
        const males = await redisClient.zRange(this.KEY_QUEUE_MALE, 0, BATCH_SIZE - 1);
        const females = await redisClient.zRange(this.KEY_QUEUE_FEMALE, 0, BATCH_SIZE - 1);

        const allUids = Array.from(new Set([...males, ...females]));
        if (allUids.length === 0) return;

        // 2. Fetch User Data
        const userDataKeys = allUids.map(uid => `${this.KEY_USER_DATA}${uid}`);
        if (userDataKeys.length === 0) return;

        const userDataValues = await redisClient.mGet(userDataKeys);

        const users = new Map<string, QueueUser>();
        const now = Date.now();

        userDataValues.forEach((json, idx) => {
            if (json) {
                try {
                    const u = JSON.parse(json) as QueueUser;
                    // Dynamic Widen Stage Calculation
                    const waitingTime = now - u.joinedAt;
                    if (waitingTime > 30000) {
                        // Timeout - INSTEAD of removing, trigger bot mode if not already active
                        if (!u.botModeActive) {
                            this.triggerBotMode(u, io);
                            // Mark as bot mode active in Redis so we don't trigger again
                            u.botModeActive = true;
                            redisClient.set(`${this.KEY_USER_DATA}${u.uid}`, JSON.stringify(u));
                        }

                        // User remains in queue for real match!
                        if (waitingTime > 10000 && u.tier !== 'DIAMOND') u.widenStage = 2;
                        else if (waitingTime > 5000) u.widenStage = 1;
                        else u.widenStage = 0;

                        users.set(u.uid, u);
                    } else {
                        if (waitingTime > 10000 && u.tier !== 'DIAMOND') u.widenStage = 2; // Diamond users never widen gender implicitly? Or maybe they do.
                        else if (waitingTime > 5000) u.widenStage = 1;
                        else u.widenStage = 0;

                        users.set(u.uid, u);
                    }
                } catch (e) { }
            }
        });

        // 3. Matching Loop (In-Memory)
        const matched = new Set<string>();

        // Sort users by join time to prioritize oldest
        const sortedUsers = Array.from(users.values()).sort((a, b) => a.joinedAt - b.joinedAt);

        for (const user of sortedUsers) {
            if (matched.has(user.uid)) continue;

            // Find best match in the loaded batch
            const bestMatch = sortedUsers.find(candidate => {
                if (candidate.uid === user.uid) return false;
                if (matched.has(candidate.uid)) return false;

                // 1. Gender Compatibility
                // User's target
                let userTarget = user.preferences.gender || (user.widenStage < 2 ? (user.gender === 'male' ? 'female' : 'male') : 'any');
                if (userTarget !== 'any' && candidate.gender !== userTarget) return false;

                // Candidate's target
                let candTarget = candidate.preferences.gender || (candidate.widenStage < 2 ? (candidate.gender === 'male' ? 'female' : 'male') : 'any');
                if (candTarget !== 'any' && candTarget !== user.gender) return false;

                // 2. Location Compatibility
                if (user.preferences.location && user.widenStage < 1 && candidate.location !== user.preferences.location) return false;
                if (candidate.preferences.location && candidate.widenStage < 1 && candidate.location !== candidate.preferences.location) return false;

                // 3. Mode Compatibility (Must match mode? random vs video?)
                // Assuming implemented, usually strictly matched
                if (user.mode !== candidate.mode) return false;

                return true;
            });

            if (bestMatch) {
                // Execute Match
                matched.add(user.uid);
                matched.add(bestMatch.uid);

                // Remove from sortedUsers to prevent re-checking? Set handles it.
                await this.executeMatch(user, bestMatch, io);
            }
        }
    }

    private async executeMatch(user1: QueueUser, user2: QueueUser, io: Server) {
        console.log(`[Queue] Matched ${user1.uid} vs ${user2.uid}`);

        // Remove from Redis (Commit)
        await this.removeUserByUid(user1.uid);
        await this.removeUserByUid(user2.uid);

        // Create Room
        await sessionService.createRoom(
            { uid: user1.uid, socketId: user1.socketId, name: user1.name },
            { uid: user2.uid, socketId: user2.socketId, name: user2.name },
            io,
            user1.mode
        );

        // Update Stats
        this.updateStats(user1.uid);
        this.updateStats(user2.uid);
    }

    private async triggerBotMode(user: QueueUser, io: Server) {
        console.log(`[Queue] Triggering Bot Mode for ${user.uid} (staying in queue)`);
        io.to(user.socketId).emit('start_bot_mode', {
            // Inform client to start bot loop but stay in queue
            reason: 'timeout_waiting'
        });
    }

    private async handleTimeout(user: QueueUser, io: Server) {
        // DEPRECATED logic - kept for reference if needed
        await this.removeUserByUid(user.uid);
        // Direct emit if local, or via Redis Adapter
        io.to(user.socketId).emit('no_match_found', {
            reason: 'timeout',
            waitedMs: Date.now() - user.joinedAt
        });
    }

    private async updateStats(uid: string) {
        if (uid.startsWith('guest_')) return;
        try {
            await db.collection('users').doc(uid).update({
                'stats.matchesToday': admin.firestore.FieldValue.increment(1),
                'stats.lastMatchDate': new Date()
            });
        } catch (e) {
            console.error(`[Queue] Failed stats update ${uid}`, e);
        }
    }
}

export const queueService = new QueueService();