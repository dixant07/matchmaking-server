import { db } from '../config/firebase';
import * as admin from 'firebase-admin';
import { sessionService } from './SessionService';
import { Socket } from 'dgram';

export interface QueueUser {
    socketId: string;
    uid: string;
    gender: 'male' | 'female';
    location?: string;
    tier: 'FREE' | 'GOLD' | 'DIAMOND';
    mode: 'random' | 'video';
    preferences: {
        gender?: 'male' | 'female';
        location?: string;
    };
    joinedAt: number;
    widenStage: 0 | 1 | 2; // 0: Strict, 1: Ignore Location, 2: Ignore Gender
}

class QueueService {
    private queues = {
        male: [] as QueueUser[],
        female: [] as QueueUser[]
    };

    private availableBots: { socketId: string, uid: string }[] = [];

    constructor() {
        // No internal interval - controlled by main loop
    }

    public registerBot(socketId: string, uid: string) {
        if (!this.availableBots.find(b => b.socketId === socketId)) {
            this.availableBots.push({ socketId, uid });
            console.log(`[Queue] Bot registered: ${socketId} (UID: ${uid}). Total bots: ${this.availableBots.length}`);
        }
    }

    public unregisterBot(socketId: string) {
        this.availableBots = this.availableBots.filter(b => b.socketId !== socketId);
        console.log(`[Queue] Bot unregistered: ${socketId}. Remaining bots: ${this.availableBots.length}`);
    }

    public async joinQueue(user: QueueUser, socket: any) {
        // Ensure user is not already in any queue (prevent duplicates/self-match setup)
        this.removeUserByUid(user.uid);

        // Add to appropriate partition
        if (user.gender === 'male') {
            this.queues.male.push(user);
        } else {
            this.queues.female.push(user);
        }

        console.log(`[Queue] User ${user.uid} joined ${user.gender} queue. Tier: ${user.tier}`);

        // Attempt immediate match
        this.findMatch(user, socket);
    }

    public removeFromQueue(socketId: string) {
        this.queues.male = this.queues.male.filter(u => u.socketId !== socketId);
        this.queues.female = this.queues.female.filter(u => u.socketId !== socketId);
    }

    public removeUserByUid(uid: string) {
        this.queues.male = this.queues.male.filter(u => u.uid !== uid);
        this.queues.female = this.queues.female.filter(u => u.uid !== uid);
    }

    private findMatch(user: QueueUser, socket: any) {
        // Determine target queue based on preference or default to opposite
        let targetQueue: QueueUser[] = [];
        let targetGender: 'male' | 'female' | 'any' = 'any';

        if (user.preferences.gender) {
            targetGender = user.preferences.gender;
        } else if (user.widenStage < 2) {
            // Default to opposite gender if not widened to 'any'
            targetGender = user.gender === 'male' ? 'female' : 'male';
        }

        // Select potential matches
        let potentialMatches: QueueUser[] = [];
        if (targetGender === 'male') potentialMatches = this.queues.male;
        else if (targetGender === 'female') potentialMatches = this.queues.female;
        else potentialMatches = [...this.queues.male, ...this.queues.female];

        // Filter matches
        const matchIndex = potentialMatches.findIndex(candidate => {
            if (candidate.socketId === user.socketId) return false;
            if (candidate.uid === user.uid) return false; // Prevent self-match

            // ADD THIS CHECK: Verify candidate socket is still active in IO
            const candidateSocket = socket.server.sockets.sockets.get(candidate.socketId);
            if (!candidateSocket) {
                // Lazily remove stale user found during search
                this.removeFromQueue(candidate.socketId);
                return false;
            }
            // 1. Gender Check (Reciprocal)
            // Does candidate match user's want? (Already filtered by targetQueue selection mostly, but check 'any')
            if (targetGender !== 'any' && candidate.gender !== targetGender) return false;

            // Does user match candidate's want?
            const candidateWants = candidate.preferences.gender || (candidate.widenStage >= 2 ? 'any' : (candidate.gender === 'male' ? 'female' : 'male'));
            if (candidateWants !== 'any' && candidateWants !== user.gender) return false;

            // 2. Location Check (Reciprocal)
            // User's location pref
            if (user.preferences.location && user.widenStage < 1) {
                if (candidate.location !== user.preferences.location) return false;
            }
            // Candidate's location pref
            if (candidate.preferences.location && candidate.widenStage < 1) {
                if (candidate.location !== candidate.preferences.location) return false;
            }

            return true;
        });

        if (matchIndex !== -1) {
            const match = potentialMatches[matchIndex];
            this.executeMatch(user, match, socket);
        } else {
            // Only emit queued status on initial join, not on every tick to avoid spamming
            // We can check if it's a new join via a flag or just rely on client to show "Searching..."
            // console.log(`[Queue] User ${user.uid} added to queue, no immediate match found`);
        }
    }

    private getQueuePosition(user: QueueUser): number {
        const queue = user.gender === 'male' ? this.queues.male : this.queues.female;
        return queue.findIndex(u => u.socketId === user.socketId) + 1;
    }

    private matchWithBot(user: QueueUser, io: any) {
        if (this.availableBots.length === 0) return;

        // Pick a random bot
        const botIndex = Math.floor(Math.random() * this.availableBots.length);
        const bot = this.availableBots[botIndex];

        // Remove bot from available pool
        this.unregisterBot(bot.socketId);

        // Create fake QueueUser for bot using REAL UID
        const botUser: QueueUser = {
            socketId: bot.socketId,
            uid: bot.uid,
            gender: 'male',
            tier: 'FREE',
            mode: user.mode,
            preferences: {},
            joinedAt: Date.now(),
            widenStage: 0
        };

        console.log(`[Queue] Matching User ${user.uid} with Bot ${bot.socketId} (UID: ${bot.uid})`);
        // Remove user from queue
        this.removeFromQueue(user.socketId);

        // Create room directly via SessionService
        if (io) {
            sessionService.createRoom(
                { uid: user.uid, socketId: user.socketId },
                { uid: botUser.uid, socketId: botUser.socketId },
                io,
                user.mode
            );
        }

        this.updateStats(user.uid);
    }

    private executeMatch(user1: QueueUser, user2: QueueUser, socket1: any) {
        // Remove both from queues
        this.removeFromQueue(user1.socketId);
        this.removeFromQueue(user2.socketId);

        // Delegate room creation to SessionService
        const io = socket1.server || socket1.nsp?.server;

        if (io) {
            sessionService.createRoom(
                { uid: user1.uid, socketId: user1.socketId },
                { uid: user2.uid, socketId: user2.socketId },
                io,
                user1.mode // Assuming matches share mode or prioritizing p1
            );
        } else {
            console.error("[Queue] Could not access IO server to create room");
        }

        // Update Stats
        this.updateStats(user1.uid);
        this.updateStats(user2.uid);

        console.log(`[Queue] Matched ${user1.uid} with ${user2.uid}`);
    }

    private async updateStats(uid: string) {
        // Skip stats update for guest users (no DB entry)
        if (uid.startsWith('guest_')) {
            console.log(`[Queue] Skipping stats update for guest user ${uid}`);
            return;
        }

        try {
            const userRef = db.collection('users').doc(uid);
            await userRef.update({
                'stats.matchesToday': admin.firestore.FieldValue.increment(1),
                'stats.lastMatchDate': new Date()
            });
        } catch (e) {
            console.error(`[Queue] Failed to update stats for ${uid}`, e);
        }
    }

    private processWidening(io: any) {
        const now = Date.now();
        const checkQueue = (queue: QueueUser[]) => {
            queue.forEach(user => {
                const waitingTime = now - user.joinedAt;

                // Stage 1: Ignore Location (after 5s)
                if (waitingTime > 5000 && user.widenStage === 0) {
                    user.widenStage = 1;
                    // console.log(`[Queue] Widening ${user.uid} to Stage 1 (Ignore Location)`);
                }

                // Stage 2: Ignore Gender (after 10s)
                if (waitingTime > 10000 && user.widenStage === 1) {
                    // Only widen gender if they are not DIAMOND tier
                    if (user.tier !== 'DIAMOND') {
                        user.widenStage = 2;
                        // console.log(`[Queue] Widening ${user.uid} to Stage 2 (Ignore Gender)`);
                    }
                }

                // Stage 3: No match found - notify client to connect to local bot (after 15s)
                if (waitingTime > 30000) {
                    console.log(`[Queue] User ${user.uid} waiting > 30s. Sending no_match_found for local bot.`);

                    // Get socket and emit no_match_found
                    const socket = io.sockets.sockets.get(user.socketId);
                    if (socket) {
                        socket.emit('no_match_found', {
                            reason: 'timeout',
                            waitedMs: waitingTime
                        });
                    }

                    // Remove from queue
                    this.removeFromQueue(user.socketId);
                }
            });
        };

        checkQueue(this.queues.male);
        checkQueue(this.queues.female);
    }

    // Helper to inject IO for widening matches if needed
    public processMatches(io: any) {
        // Run widening first to ensure eligible users can be matched immediately
        this.processWidening(io);

        [...this.queues.male, ...this.queues.female].forEach(user => {
            // Check if user was removed by a previous iteration in this very loop
            const isStillInQueue = this.queues.male.includes(user) || this.queues.female.includes(user);
            if (!isStillInQueue) return; // SKIP if already matched
            const socket = io.sockets.sockets.get(user.socketId);
            if (socket) {
                this.findMatch(user, socket);
            } else {
                // Remove stale socket if not found
                this.removeFromQueue(user.socketId);
            }
        });
    }
}

export const queueService = new QueueService();