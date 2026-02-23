import { Server, Socket } from 'socket.io';
import crypto from 'crypto';
import redisClient from '../config/redis';
import { analyticsService } from './AnalyticsService';

interface RoomData {
    roomId: string;
    playerA: { uid: string; socketId: string };
    playerB: { uid: string; socketId: string };
    gameReady: boolean;
    videoReady: boolean;
    expectedServices: string[];
    createdAt: number;
}

interface SessionData {
    roomId: string;
    opponentId: string; // uid of opponent
    role: 'A' | 'B';
    startTime: number;
}

// ICE Server type definitions
interface IceServer {
    urls: string;
    username?: string;
    credential?: string;
}

// Default STUN servers
const DEFAULT_STUN_SERVERS: IceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const CREDENTIAL_TTL = 24 * 3600;

const generateTurnCredentials = (uid: string, turnUrl: string, turnSecret: string): IceServer => {
    const timestamp = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL;
    const username = `${timestamp}:${uid}`;
    const hmac = crypto.createHmac('sha1', turnSecret);
    hmac.update(username);
    const credential = hmac.digest('base64');
    return { urls: turnUrl, username, credential };
};

const buildIceServersForUser = (uid: string) => {
    const gameServers: IceServer[] = [];
    const videoServers: IceServer[] = [...DEFAULT_STUN_SERVERS];

    const gameTurnUrl = process.env.GAME_TURN_URL;
    const gameTurnSecret = process.env.GAME_TURN_SECRET;
    if (gameTurnUrl && gameTurnSecret && gameTurnUrl.startsWith('turn')) {
        gameServers.push(generateTurnCredentials(uid, gameTurnUrl, gameTurnSecret));
    } else {
        gameServers.push(...DEFAULT_STUN_SERVERS);
    }

    const videoTurnUrl = process.env.VIDEO_TURN_URL;
    const videoTurnSecret = process.env.VIDEO_TURN_SECRET;
    if (videoTurnUrl && videoTurnSecret && videoTurnUrl.startsWith('turn')) {
        videoServers.push(generateTurnCredentials(uid, videoTurnUrl, videoTurnSecret));
    }

    return { game: gameServers, video: videoServers };
};

class SessionService {
    // Redis Key Prefixes
    private readonly PREFIX_ROOM = 'room:';
    private readonly PREFIX_SESSION = 'session:';
    private readonly PREFIX_SOCKET_UID = 'socket:uid:';
    private readonly PREFIX_USER_SOCKET = 'user:socket:';
    private readonly SET_ONLINE_USERS = 'users:online';

    constructor() { }

    /**
     * Store mapping of Socket ID -> UID and UID -> Socket ID
     * TTL: 24 hours (auto-cleanup if stale)
     */
    public async registerSocket(socketId: string, uid: string) {
        console.log(`[Session] Registering socket ${socketId} for UID ${uid}`);

        // socket:uid:{socketId} -> uid
        await redisClient.set(`${this.PREFIX_SOCKET_UID}${socketId}`, uid, { EX: 86400 });

        // user:socket:{uid} -> socketId (One active socket per user preference)
        await redisClient.set(`${this.PREFIX_USER_SOCKET}${uid}`, socketId, { EX: 86400 });

        // Add to online users set (Analytics)
        if (!uid.startsWith('bot_') && !uid.startsWith('guest_')) {
            await redisClient.sAdd(this.SET_ONLINE_USERS, uid);
            analyticsService.logUserConnected(uid, socketId);
        }
    }

    /**
     * Get socket IDs for a user
     * With Redis adapter, we can emit to a room/socket even if on another node.
     * We just need the socket ID.
     */
    public async getSocketIdsForUser(uid: string): Promise<string[]> {
        const socketId = await redisClient.get(`${this.PREFIX_USER_SOCKET}${uid}`);
        return socketId ? [socketId] : [];
    }

    /**
     * Create a pending room (handshake state)
     */
    public async createRoom(userA: { uid: string; socketId: string }, userB: { uid: string; socketId: string }, io: Server, mode: 'random' | 'video' = 'random') {
        const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        console.log(`[Session] Creating room ${roomId} for ${userA.uid} vs ${userB.uid}`);

        // [FIX] Strict lookup of current sockets from Redis to ensure they are online
        // Use the sockets passed in, BUT verify they are still the 'active' ones
        const currentSocketA = await redisClient.get(`${this.PREFIX_USER_SOCKET}${userA.uid}`);
        const currentSocketB = await redisClient.get(`${this.PREFIX_USER_SOCKET}${userB.uid}`);

        if (!currentSocketA || !currentSocketB) {
            console.warn(`[Session] Aborting match ${roomId}. Users offline.`);
            return;
        }

        userA.socketId = currentSocketA;
        userB.socketId = currentSocketB;

        // Only require 'video' to finalize the session.
        // Previously required 'game' too, but game signaling doesn't run during video-chat,
        // so the session was NEVER written to Redis → signal routing broke → 30s drop.
        const expectedServices = ['video'];

        const roomData: RoomData = {
            roomId,
            playerA: userA,
            playerB: userB,
            gameReady: false,
            videoReady: false,
            expectedServices,
            createdAt: Date.now()
        };

        // Store in Redis with TTL (e.g., 5 mins for handshake)
        await redisClient.set(`${this.PREFIX_ROOM}${roomId}`, JSON.stringify(roomData), { EX: 300 });

        // Get Names (Note: This is tricky in distributed systems if socket is not local)
        // Optimization: For now, we omit name in 'match_found' if not local, or client fetches it.
        // Or store profile in Redis. Assuming minimal need for name in handshake.

        const iceServersA = buildIceServersForUser(userA.uid);
        const iceServersB = buildIceServersForUser(userB.uid);

        // Notify A
        io.to(userA.socketId).emit('match_found', {
            roomId,
            role: "A",
            opponentId: userB.socketId,
            opponentUid: userB.uid,
            isInitiator: true,
            iceServers: iceServersA
        });

        // Notify B
        io.to(userB.socketId).emit('match_found', {
            roomId,
            role: "B",
            opponentId: userA.socketId,
            opponentUid: userA.uid,
            isInitiator: false,
            iceServers: iceServersB
        });

        console.log(`[Session] Match emitted for ${roomId}`);
    }

    /**
     * Handle 'connection_stable' event
     */
    public async handleConnectionStable(socket: Socket, roomId: string, service: 'game' | 'video') {
        const roomStr = await redisClient.get(`${this.PREFIX_ROOM}${roomId}`);
        if (!roomStr) return;

        const room = JSON.parse(roomStr) as RoomData;

        if (service === 'game') room.gameReady = true;
        if (service === 'video') room.videoReady = true;

        // Update Redis
        await redisClient.set(`${this.PREFIX_ROOM}${roomId}`, JSON.stringify(room), { KEEPTTL: true });

        const isGameSatisfied = room.expectedServices.includes('game') ? room.gameReady : true;
        const isVideoSatisfied = room.expectedServices.includes('video') ? room.videoReady : true;

        if (isGameSatisfied && isVideoSatisfied) {
            // Get IO instance from socket
            const io = (socket as any).server || (socket.nsp as any).server;
            if (io) {
                await this.finalizeConnection(roomId, io);
            }
        }
    }

    /**
     * Move room to active session
     */
    private async finalizeConnection(roomId: string, io: Server) {
        const roomStr = await redisClient.get(`${this.PREFIX_ROOM}${roomId}`);
        if (!roomStr) return;
        const room = JSON.parse(roomStr) as RoomData;

        console.log(`[Session] Room ${roomId} fully established.`);

        const startTime = Date.now();
        const sessionA: SessionData = { roomId, opponentId: room.playerB.uid, role: 'A', startTime };
        const sessionB: SessionData = { roomId, opponentId: room.playerA.uid, role: 'B', startTime };

        // Store active sessions (Unlimited TTL - until disconnect)
        await redisClient.set(`${this.PREFIX_SESSION}${room.playerA.uid}`, JSON.stringify(sessionA));
        await redisClient.set(`${this.PREFIX_SESSION}${room.playerB.uid}`, JSON.stringify(sessionB));

        io.to(room.playerA.socketId).emit('session_established', { roomId });
        io.to(room.playerB.socketId).emit('session_established', { roomId });

        // Analytics: Match Start
        const isBotMatch = room.playerA.uid.startsWith('bot_') || room.playerB.uid.startsWith('bot_');
        analyticsService.logMatchStart(roomId, [room.playerA.uid, room.playerB.uid], 'random', isBotMatch);

        // Remove pending room
        await redisClient.del(`${this.PREFIX_ROOM}${roomId}`);
    }

    /**
     * Clear active session for a user
     */
    public async clearSession(uid: string) {
        const sessionStr = await redisClient.get(`${this.PREFIX_SESSION}${uid}`);
        if (sessionStr) {
            const session = JSON.parse(sessionStr) as SessionData;
            console.log(`[Session] Clearing session for ${uid}`);

            await redisClient.del(`${this.PREFIX_SESSION}${uid}`);

            // Also clear opponent
            await redisClient.del(`${this.PREFIX_SESSION}${session.opponentId}`);
        }
    }

    /**
     * Handle Disconnect
     */
    public async handleDisconnect(socketId: string, io: Server) {
        const uid = await redisClient.get(`${this.PREFIX_SOCKET_UID}${socketId}`);
        if (uid) {
            // Remove socket mapping
            await redisClient.del(`${this.PREFIX_SOCKET_UID}${socketId}`);

            const currentActiveSocket = await redisClient.get(`${this.PREFIX_USER_SOCKET}${uid}`);

            if (currentActiveSocket === socketId) {
                // Active socket disconnected
                await redisClient.del(`${this.PREFIX_USER_SOCKET}${uid}`);
                console.log(`[Session] Active socket for ${uid} disconnected.`);

                // Analytics: User Disconnected
                if (!uid.startsWith('bot_') && !uid.startsWith('guest_')) {
                    await redisClient.sRem(this.SET_ONLINE_USERS, uid);
                    analyticsService.logUserDisconnected(uid, 0); // TODO: Track session duration if needed
                }

                // Check Active Session
                const sessionStr = await redisClient.get(`${this.PREFIX_SESSION}${uid}`);
                if (sessionStr) {
                    const session = JSON.parse(sessionStr) as SessionData;
                    const opponentUid = session.opponentId;

                    console.log(`[Session] User ${uid} disconnected from active session. Notifying ${opponentUid}.`);

                    // Analytics: Match End
                    const durationSeconds = (Date.now() - session.startTime) / 1000;
                    const isBotMatch = uid.startsWith('bot_') || opponentUid.startsWith('bot_');
                    analyticsService.logMatchEnd(session.roomId, durationSeconds, 'disconnect', isBotMatch);


                    // Notify Opponent
                    const opponentSockets = await this.getSocketIdsForUser(opponentUid);
                    opponentSockets.forEach(sid => io.to(sid).emit('match_skipped'));

                    // Cleanup
                    await redisClient.del(`${this.PREFIX_SESSION}${uid}`);
                    await redisClient.del(`${this.PREFIX_SESSION}${opponentUid}`);
                }

                // Check Pending Rooms (Expensive scan, but necessary or rely on TTL)
                // Optimization: Maybe store `user:room:{uid}` -> roomId to find pending rooms quickly
                // For now, let's rely on TTL or iterating a small set if needed.
                // Or better: Let the other user timeout if handshake fails.
                // But immediate notification is nice.
                // We'll skip complex Pending Room lookup for now to save perf, 
                // relying on the opponent's client or server timeout.
            }
        }
    }

    /**
     * Handle Reconnection
     */
    public async handleReconnection(socket: Socket, uid: string) {
        // Check Session Cache
        const sessionStr = await redisClient.get(`${this.PREFIX_SESSION}${uid}`);
        if (sessionStr) {
            const session = JSON.parse(sessionStr) as SessionData;
            console.log(`[Session] User ${uid} reconnecting to session ${session.roomId}`);

            const opponentUid = session.opponentId;
            const opponentSockets = await this.getSocketIdsForUser(opponentUid);
            const opponentSocketId = opponentSockets[0]; // Primary socket

            socket.emit('match_found', {
                roomId: session.roomId,
                role: session.role,
                opponentId: opponentSocketId,
                opponentUid: opponentUid,
                isInitiator: session.role === 'A',
                iceServers: buildIceServersForUser(uid),
                isReconnection: true
            });

            if (opponentSocketId) {
                socket.to(opponentSocketId).emit('opponent_reconnected', {
                    message: 'Opponent is back online',
                    opponentSocketId: socket.id
                });
            }
            return;
        }

        // Check Pending Rooms? (Harder with Redis without secondary index)
        // If critical, we can add `user:pendingRoom:{uid}` -> roomId match.
    }

    public async hasActiveSession(uid: string): Promise<boolean> {
        return (await redisClient.exists(`${this.PREFIX_SESSION}${uid}`)) > 0;
    }

    public async handleSkipMatch(socketId: string, io: Server) {
        const uid = await redisClient.get(`${this.PREFIX_SOCKET_UID}${socketId}`);
        if (uid) {
            const sessionStr = await redisClient.get(`${this.PREFIX_SESSION}${uid}`);
            if (sessionStr) {
                const session = JSON.parse(sessionStr) as SessionData;
                const opponentUid = session.opponentId;

                // Analytics: Match End
                const durationSeconds = (Date.now() - session.startTime) / 1000;
                const isBotMatch = uid.startsWith('bot_') || opponentUid.startsWith('bot_');
                analyticsService.logMatchEnd(session.roomId, durationSeconds, 'skip', isBotMatch);

                // Notify
                const uSockets = await this.getSocketIdsForUser(uid);
                const oSockets = await this.getSocketIdsForUser(opponentUid);

                [...uSockets, ...oSockets].forEach(sid => io.to(sid).emit('match_skipped'));

                await redisClient.del(`${this.PREFIX_SESSION}${uid}`);
                await redisClient.del(`${this.PREFIX_SESSION}${opponentUid}`);
                return;
            }
        }

        // Fallback
        io.to(socketId).emit('match_skipped');
    }

    public getIceServersConfig(uid: string = 'anonymous') {
        return buildIceServersForUser(uid);
    }

    public async cleanupStaleRooms(io: Server) {
        // Redis cleanup is handled by TTL mostly.
        // But if we want to notify users of timeout:
        // We would need to SCAN `room:*` and check createdAt.
        // If room has TTL, it just vanishes. Users hang?
        // Better: Client side timeout for handshake.
        // Or: Use Redis Keyspace Notifications (advanced).
        // For simplistic approach: rely on client timeout + Redis TTL.
    }

    public async getOpponentUid(uid: string): Promise<string | null> {
        const sessionStr = await redisClient.get(`${this.PREFIX_SESSION}${uid}`);
        if (sessionStr) {
            return (JSON.parse(sessionStr) as SessionData).opponentId;
        }
        return null;
    }
}

export const sessionService = new SessionService();
